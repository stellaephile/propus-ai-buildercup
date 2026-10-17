"""
cluster_stops.py
----------------
Builds derived.stop_clusters — the physical-stop crosswalk that stops Propus
double-counting bus stops.

THE PROBLEM
    The OTD Delhi bus feed publishes no parent_station and no location_type, so
    GTFS's own mechanism for grouping boarding points into a station is absent.
    Counting raw stop_id inflates every stop-based metric ~2.6x, in two
    separable ways:

      stop_id           10,559   one row per (pole x serving route)
      stop_code          6,880   one row per PHYSICAL POLE        [Observed]
      physical_stop_id  ~4,388   one row per STOP LOCATION        [Estimated]

    Tier 1 (stop_id -> stop_code) is lossless: every stop_code in this feed maps
    to exactly one (lat, lon, stop_name), max 2 rows per code. It removes the
    "same pole listed once per route" duplication with no assumptions at all.

    Tier 2 (stop_code -> physical_stop_id) is a spatial judgement: it merges the
    two poles either side of a road into one stop LOCATION. 97% of 2-member
    clusters sit 3-40 m apart (median 20.4 m) — the directional-pair signature.
    Justification: their 500 m walk catchments overlap 97.4%, so the second pole
    adds ~3% coverage area while doubling the numerator of every density metric.
    This tier is Estimated, never Observed (CLAUDE.md §3.3).

WHY COMPLETE LINKAGE, NOT DBSCAN
    PostGIS's ST_ClusterDBSCAN / ST_ClusterWithin are single-linkage and chain
    along corridors. Measured on this feed at a 50 m threshold: DBSCAN produced
    a 182 m-diameter cluster, complete linkage 61 m. A 182 m blob cannot
    honestly be called one stop. Complete linkage guarantees every cluster's
    diameter <= the threshold, which is the property a GIS reviewer will check.

    The nearest-neighbour distance distribution here is a smooth continuum
    (p25 15 m, p50 26 m, p75 55 m) with no density gap, so density-based
    clustering has nothing to key on anyway.

WHY 40 m, AND WHY NAMES ARE NOT A GATE
    Calibrated from the data: stop pairs sharing a byte-identical stop_name sit
    at a median 20.4 m apart. 40 m clears that while staying well under half the
    typical 200-300 m Delhi bus-stop spacing, so it is structurally incapable of
    merging two genuinely distinct stops.

    stop_name is NOT used as a merge gate. The feed's transliteration is
    inconsistent in both directions: "Safiyabad Crossing" / "shafiabad more" are
    one place, while "Prem Nagar" names 20 different places (p99 same-name
    separation 2.6 km). Gating on names would both under- and over-merge. Names
    are recorded as a QA signal (name_agreement) and nothing more.

    Metro needs none of this: 262 stations, 262 distinct names, no duplication.

Usage:
    python pipeline/cluster_stops.py                # DB + CSV artifact
    python pipeline/cluster_stops.py --csv-only     # no DB (frontend fixture)
    python pipeline/cluster_stops.py --threshold 30 # sensitivity check

Requires:
    DATABASE_URL in .env (unless --csv-only)
    schema.sql applied
    data/processed/bus/stops.csv (from clean_gtfs.py)
"""

import os
import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from pyproj import Transformer
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.sparse.csgraph import connected_components
from scipy.spatial.distance import pdist
from sklearn.neighbors import radius_neighbors_graph

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[1]
STOPS_CSV = ROOT / "data/processed/bus/stops.csv"
OUT_CSV = ROOT / "data/processed/derived/stop_clusters.csv"

# Metres. See module docstring for the calibration.
DEFAULT_THRESHOLD_M = 40.0
# All distance work happens here, never in geographic degrees (CLAUDE.md §3.5).
PROJECTED_CRS = "EPSG:32643"   # UTM 43N, Delhi
GEOGRAPHIC_CRS = "EPSG:4326"


def load_boarding_points() -> pd.DataFrame:
    """
    Tier 1: collapse stop_id rows to distinct stop_code (physical poles).

    Lossless by construction — asserted, not assumed. If a future feed revision
    breaks the 1:1 stop_code -> (lat, lon) property this raises rather than
    silently averaging two real locations together.
    """
    if not STOPS_CSV.exists():
        raise SystemExit(f"missing {STOPS_CSV} — run pipeline/clean_gtfs.py first")

    df = pd.read_csv(STOPS_CSV, dtype={"stop_id": str, "stop_code": str})
    n_rows = len(df)

    if "stop_code" not in df.columns or df.stop_code.isna().all():
        raise SystemExit(
            "stops.csv has no usable stop_code column — re-run clean_gtfs.py. "
            "Refusing to cluster on coordinates alone: the lossless tier must "
            "run first or the Observed boarding-point count is unavailable."
        )

    # Verify the 1:1 property that makes tier 1 lossless.
    per_code = df.groupby("stop_code")
    bad_coord = (per_code[["stop_lat", "stop_lon"]].nunique() > 1).any(axis=1).sum()
    if bad_coord:
        raise SystemExit(
            f"{bad_coord} stop_codes map to >1 coordinate — the lossless "
            f"collapse assumption no longer holds for this feed. Stop and "
            f"re-derive the physical key before trusting any stop count."
        )

    bp = df.drop_duplicates("stop_code").reset_index(drop=True)
    log.info(
        f"  Tier 1 (lossless): {n_rows} stop_id rows -> {len(bp)} stop_code "
        f"boarding points [Observed]"
    )
    return df, bp


def cluster_boarding_points(bp: pd.DataFrame, threshold_m: float) -> pd.DataFrame:
    """
    Tier 2: complete-linkage agglomerative clustering at `threshold_m`.

    Partitioned by connected components of the `threshold_m` radius graph first.
    That is an exact optimisation, not an approximation: complete linkage merges
    two clusters at their MAXIMUM pairwise distance, so two points with no
    edge <= threshold between them can never merge below the threshold. It turns
    an O(n^2) 380 MB distance matrix into a few thousand tiny ones.
    """
    to_utm = Transformer.from_crs(GEOGRAPHIC_CRS, PROJECTED_CRS, always_xy=True)
    to_wgs = Transformer.from_crs(PROJECTED_CRS, GEOGRAPHIC_CRS, always_xy=True)
    x, y = to_utm.transform(bp.stop_lon.values, bp.stop_lat.values)
    X = np.c_[x, y]

    graph = radius_neighbors_graph(X, radius=threshold_m, mode="connectivity")
    n_comp, comp = connected_components(graph, directed=False)
    log.info(f"  {n_comp} connected components at {threshold_m:.0f} m")

    labels = np.full(len(bp), -1, dtype=np.int64)
    diameters = np.zeros(len(bp))
    next_label = 0

    for c in range(n_comp):
        idx = np.flatnonzero(comp == c)
        if len(idx) == 1:
            labels[idx[0]] = next_label
            diameters[idx[0]] = 0.0
            next_label += 1
            continue

        d = pdist(X[idx])
        sub = fcluster(linkage(d, method="complete"), t=threshold_m, criterion="distance")
        for s in np.unique(sub):
            members = idx[sub == s]
            labels[members] = next_label
            # exact cluster diameter = max pairwise distance among members
            diameters[members] = pdist(X[members]).max() if len(members) > 1 else 0.0
            next_label += 1

    out = bp.copy()
    out["_label"] = labels
    out["diameter_m"] = np.round(diameters, 2)

    # Centroid in PROJECTED space, then converted back — averaging degrees
    # would be wrong (CLAUDE.md §3.5).
    out["_x"], out["_y"] = x, y
    cen = out.groupby("_label")[["_x", "_y"]].mean()
    clon, clat = to_wgs.transform(cen["_x"].values, cen["_y"].values)
    cen["centroid_lon"] = np.round(clon, 5)   # 5 dp ~ 1 m (§5 payload budget)
    cen["centroid_lat"] = np.round(clat, 5)
    cen["member_count"] = out.groupby("_label").size()

    out = out.join(cen[["centroid_lon", "centroid_lat", "member_count"]], on="_label")

    # Stable, content-derived id — survives a re-run and reorders safely.
    out["physical_stop_id"] = [
        f"ps_{lon:.5f}_{lat:.5f}"
        for lon, lat in zip(out.centroid_lon, out.centroid_lat)
    ]

    max_d = out.diameter_m.max()
    assert max_d <= threshold_m + 1e-6, f"complete-linkage invariant broken: {max_d}"

    n_clusters = out.physical_stop_id.nunique()
    log.info(
        f"  Tier 2 (Estimated): {len(bp)} boarding points -> {n_clusters} "
        f"physical stops; max cluster diameter {max_d:.1f} m (<= {threshold_m:.0f} m)"
    )
    sizes = out.groupby("physical_stop_id").size().value_counts().sort_index()
    log.info("  cluster size distribution: " +
             ", ".join(f"{k}:{v}" for k, v in sizes.items()))
    return out


def build_crosswalk(df: pd.DataFrame, clustered: pd.DataFrame, threshold_m: float) -> pd.DataFrame:
    """Expand the per-stop_code clustering back to every stop_id row."""
    cols = [
        "stop_code", "physical_stop_id", "centroid_lon", "centroid_lat",
        "member_count", "diameter_m",
    ]
    cw = df[["stop_id", "stop_code"]].merge(clustered[cols], on="stop_code", how="left")

    missing = cw.physical_stop_id.isna().sum()
    if missing:
        raise SystemExit(f"{missing} stop_ids failed to map to a cluster — aborting")

    cw["method"] = "complete_linkage"
    cw["threshold_m"] = threshold_m
    cw["crs"] = PROJECTED_CRS
    return cw


def write_db(cw: pd.DataFrame) -> None:
    from sqlalchemy import create_engine, text
    from dotenv import load_dotenv
    load_dotenv()

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL not set — use --csv-only to skip the DB write")

    engine = create_engine(url)
    with engine.connect() as conn:
        conn.execute(text("TRUNCATE derived.stop_clusters"))
        conn.commit()

    cw.to_sql(
        "stop_clusters", engine, schema="derived",
        if_exists="append", index=False, method=_psql_copy_writer,
    )
    with engine.connect() as conn:
        n = conn.execute(text("SELECT COUNT(*) FROM derived.stop_clusters")).scalar()
        p = conn.execute(
            text("SELECT COUNT(DISTINCT physical_stop_id) FROM derived.stop_clusters")
        ).scalar()
    log.info(f"  ✓ derived.stop_clusters: {n} rows, {p} distinct physical stops")


def _psql_copy_writer(table, conn, keys, data_iter):
    """COPY FROM STDIN writer — mirrors precompute_route_aggregates.py."""
    import io
    import csv
    raw = conn.connection
    with raw.cursor() as cur:
        buf = io.StringIO()
        csv.writer(buf, quoting=csv.QUOTE_MINIMAL).writerows(data_iter)
        buf.seek(0)
        cols = ", ".join(f'"{k}"' for k in keys)
        cur.copy_expert(
            f'COPY "{table.schema}"."{table.name}" ({cols}) FROM STDIN WITH (FORMAT CSV)', buf
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the physical-stop crosswalk")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD_M,
                    help=f"merge distance in metres (default {DEFAULT_THRESHOLD_M:.0f})")
    ap.add_argument("--csv-only", action="store_true",
                    help="write the CSV artifact only, no database write")
    args = ap.parse_args()

    log.info(f"Clustering bus stops @ {args.threshold:.0f} m in {PROJECTED_CRS}")
    df, bp = load_boarding_points()
    clustered = cluster_boarding_points(bp, args.threshold)
    cw = build_crosswalk(df, clustered, args.threshold)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    cw.to_csv(OUT_CSV, index=False)
    log.info(f"  ✓ {OUT_CSV.relative_to(ROOT)} ({len(cw)} rows)")

    if not args.csv_only:
        write_db(cw)

    log.info(
        f"Done. stop_id {len(df)} | stop_code {len(bp)} [Observed] | "
        f"physical {cw.physical_stop_id.nunique()} [Estimated]"
    )


if __name__ == "__main__":
    main()

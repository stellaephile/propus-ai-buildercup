"""
load_pop_cells.py
-----------------
Builds the precomputed inputs for the coverage_gap tool (docs/DECISIONS.md D7–D10):

    derived.transit_points  physical bus stops + metro stations, with trips/day
    derived.pop_cells       WorldPop 100 m cell centres inside Delhi's wards,
                            with straight-line distance to the nearest bus,
                            metro and any transit point (EPSG:32643)

WorldPop source: the Delhi-clipped EPSG:4326 raster written by rs_worldpop.py
(data/worldpop/ind_ppp_2020_epsg4326.tif). Cells are kept when their centre
falls inside the ward union (rasterio mask, all_touched=False).

Re-running truncates both tables; derived.stop_heat is cleared with them
(FK cascade), so re-run stop_heat_ee.py afterwards.

Usage:
    python pipeline/load_pop_cells.py
    python pipeline/load_pop_cells.py --dry-run \
        --wards apps/web/public/fixtures/wards.geojson   # raster check, no DB

Requires:
    DATABASE_URL in .env (unless --dry-run), schema.sql applied,
    derived.stop_clusters and derived.stop_hourly_frequency loaded.
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import rasterio
from rasterio.mask import mask

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

DEFAULT_TIF = Path("data/worldpop/ind_ppp_2020_epsg4326.tif")

TRANSIT_POINTS_SQL = """
INSERT INTO derived.transit_points (point_id, mode, name, trips_day, geom, geom_utm)
SELECT 'bus:' || c.physical_stop_id,
       'bus',
       MIN(s.stop_name),
       COALESCE(SUM(f.trips), 0)::int,
       ST_SetSRID(ST_MakePoint(MIN(c.centroid_lon), MIN(c.centroid_lat)), 4326),
       ST_Transform(ST_SetSRID(ST_MakePoint(MIN(c.centroid_lon), MIN(c.centroid_lat)), 4326), 32643)
FROM derived.stop_clusters c
JOIN gtfs_bus.stops s USING (stop_id)
LEFT JOIN (SELECT stop_id, SUM(trip_count) AS trips
           FROM derived.stop_hourly_frequency GROUP BY stop_id) f USING (stop_id)
GROUP BY c.physical_stop_id;

INSERT INTO derived.transit_points (point_id, mode, name, trips_day, geom, geom_utm)
SELECT 'metro:' || s.stop_id,
       'metro',
       s.stop_name,
       COALESCE(t.trips, 0)::int,
       s.geom,
       ST_Transform(s.geom, 32643)
FROM gtfs_metro.stops s
LEFT JOIN (SELECT stop_id, COUNT(DISTINCT trip_id) AS trips
           FROM gtfs_metro.stop_times GROUP BY stop_id) t USING (stop_id)
WHERE s.geom IS NOT NULL;
"""

# KNN (<->) on the GiST index, exact distance in metres in EPSG:32643.
DISTANCE_SQL = """
UPDATE derived.pop_cells p SET
    dist_bus_m = (SELECT ST_Distance(p.geom_utm, t.geom_utm) FROM derived.transit_points t
                  WHERE t.mode = 'bus' ORDER BY p.geom_utm <-> t.geom_utm LIMIT 1),
    dist_metro_m = (SELECT ST_Distance(p.geom_utm, t.geom_utm) FROM derived.transit_points t
                    WHERE t.mode = 'metro' ORDER BY p.geom_utm <-> t.geom_utm LIMIT 1);
UPDATE derived.pop_cells SET dist_any_m = LEAST(dist_bus_m, dist_metro_m);
"""


def load_cells(tif: Path, wards: gpd.GeoDataFrame) -> pd.DataFrame:
    """Populated WorldPop cell centres whose centre lies inside the ward union."""
    boundary = wards.to_crs(4326).geometry.union_all()
    with rasterio.open(tif) as src:
        if src.crs.to_epsg() != 4326:
            raise SystemExit(f"{tif} is {src.crs}, expected EPSG:4326 (run rs_worldpop.py)")
        arr, transform = mask(src, [boundary], crop=True, nodata=src.nodata)
        nodata = src.nodata
    band = arr[0]
    rows, cols = np.where((band != nodata) & (band > 0))
    xs, ys = rasterio.transform.xy(transform, rows, cols)
    return pd.DataFrame({
        "cell_id": np.arange(1, len(rows) + 1),
        "pop": band[rows, cols].astype(float),
        "lon": np.round(np.asarray(xs), 6),
        "lat": np.round(np.asarray(ys), 6),
    })


def write_db(cells: pd.DataFrame, engine) -> None:
    from sqlalchemy import text

    with engine.begin() as conn:
        conn.execute(text("SET LOCAL statement_timeout = 0"))
        conn.execute(text("TRUNCATE derived.transit_points, derived.pop_cells CASCADE"))
        conn.execute(text(TRANSIT_POINTS_SQL))
        n_bus, n_metro = conn.execute(text(
            "SELECT COUNT(*) FILTER (WHERE mode='bus'), COUNT(*) FILTER (WHERE mode='metro') "
            "FROM derived.transit_points")).one()
        log.info(f"  ✓ transit_points: {n_bus} bus physical stops, {n_metro} metro stations")

        conn.execute(text("CREATE TEMP TABLE _cells (cell_id int, pop real, lon float8, lat float8) "
                          "ON COMMIT DROP"))
        raw = conn.connection.driver_connection
        with raw.cursor() as cur:
            import io
            buf = io.StringIO()
            cells.to_csv(buf, index=False, header=False)
            buf.seek(0)
            cur.copy_expert("COPY _cells FROM STDIN WITH (FORMAT CSV)", buf)
        conn.execute(text("""
            INSERT INTO derived.pop_cells (cell_id, pop, geom, geom_utm)
            SELECT cell_id, pop, g, ST_Transform(g, 32643)
            FROM (SELECT cell_id, pop, ST_SetSRID(ST_MakePoint(lon, lat), 4326) AS g FROM _cells) c
        """))
        conn.execute(text("ANALYZE derived.transit_points; ANALYZE derived.pop_cells"))
        log.info("  computing nearest-stop distances (EPSG:32643)…")
        conn.execute(text(DISTANCE_SQL))

    with engine.connect() as conn:
        n, pop, nulls, ward_pop, size = conn.execute(text("""
            SELECT COUNT(*), SUM(pop), COUNT(*) FILTER (WHERE dist_any_m IS NULL),
                   (SELECT SUM(pop_total) FROM derived.ward_metrics),
                   pg_size_pretty(pg_total_relation_size('derived.pop_cells'))
            FROM derived.pop_cells""")).one()
    log.info(f"  ✓ pop_cells: {n:,} cells, pop {pop:,.0f}, NULL distances {nulls}, size {size}")
    if ward_pop:
        diff = 100 * (pop - ward_pop) / ward_pop
        log.info(f"  ward_metrics pop_total {ward_pop:,.0f} → difference {diff:+.2f}%")
        if abs(diff) > 2:
            log.warning("  difference exceeds 2% (TASKS S1 DoD) — check raster and ward union")


def main() -> None:
    ap = argparse.ArgumentParser(description="Load WorldPop cells + transit points for coverage_gap")
    ap.add_argument("--tif", type=Path, default=DEFAULT_TIF)
    ap.add_argument("--wards", type=Path, help="ward GeoJSON instead of public.wards")
    ap.add_argument("--dry-run", action="store_true", help="raster check only, no DB writes")
    args = ap.parse_args()

    engine = None
    if not args.dry_run:
        from dotenv import load_dotenv
        from sqlalchemy import create_engine
        load_dotenv()
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise SystemExit("DATABASE_URL not set — use --dry-run to skip the DB write")
        engine = create_engine(url)

    if args.wards:
        wards = gpd.read_file(args.wards)
    elif engine is not None:
        wards = gpd.read_postgis("SELECT geometry FROM public.wards", engine, geom_col="geometry")
    else:
        raise SystemExit("--dry-run needs --wards")

    cells = load_cells(args.tif, wards)
    log.info(f"  {len(cells):,} populated cells, total pop {cells['pop'].sum():,.0f}")

    if engine is not None:
        write_db(cells, engine)


if __name__ == "__main__":
    main()

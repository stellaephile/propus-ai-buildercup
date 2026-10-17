"""
stop_heat_ee.py
---------------
Builds derived.stop_heat for the stop_heat_exposure tool (docs/DECISIONS.md D11).

For every row in derived.transit_points: mean Landsat 8/9 Collection 2 Level 2
land surface temperature (ST_B10, °C) within 100 m of the point, from the
cloud/shadow-masked median of April–June scenes, 2023–2025.

This is LAND SURFACE temperature — a relative exposure indicator, not air or
felt temperature. Points with no clear pixel get NULL, never a filled value.

Run once, offline; the app never calls Earth Engine at runtime (D7).
Re-run after load_pop_cells.py (its truncate clears this table via FK cascade).

Usage:
    python pipeline/stop_heat_ee.py
    python pipeline/stop_heat_ee.py --dry-run --limit 50   # EE check, no DB write

Requires:
    DATABASE_URL in .env, schema.sql applied, load_pop_cells.py run.
    Earth Engine: GEE_SERVICE_ACCOUNT + GOOGLE_APPLICATION_CREDENTIALS (key file
    path) in .env, or user credentials from `earthengine authenticate` with
    EE_PROJECT set.
"""

from __future__ import annotations

import argparse
import logging
import os

import ee
import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

YEARS = (2023, 2024, 2025)
COLLECTIONS = ("LANDSAT/LC08/C02/T1_L2", "LANDSAT/LC09/C02/T1_L2")
BUFFER_M = 100
CHUNK = 1000  # keeps each getInfo payload small


def init_ee() -> None:
    sa, key = os.getenv("GEE_SERVICE_ACCOUNT"), os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if sa and key:
        ee.Initialize(ee.ServiceAccountCredentials(sa, key))
    else:
        ee.Initialize(project=os.environ["EE_PROJECT"])
    log.info("  ✓ Earth Engine initialised")


def _lst_celsius(img: ee.Image) -> ee.Image:
    qa = img.select("QA_PIXEL")
    # bits 1 dilated cloud, 3 cloud, 4 cloud shadow
    clear = (qa.bitwiseAnd(1 << 1).eq(0)
             .And(qa.bitwiseAnd(1 << 3).eq(0))
             .And(qa.bitwiseAnd(1 << 4).eq(0)))
    lst = img.select("ST_B10").multiply(0.00341802).add(149.0).subtract(273.15)
    return lst.rename("lst_c").updateMask(clear)


def summer_lst(aoi: ee.Geometry) -> ee.Image:
    col = None
    for cid in COLLECTIONS:
        for y in YEARS:
            c = ee.ImageCollection(cid).filterDate(f"{y}-04-01", f"{y}-07-01")
            col = c if col is None else col.merge(c)
    return col.filterBounds(aoi).map(_lst_celsius).median()


def sample(points: pd.DataFrame) -> pd.DataFrame:
    aoi = ee.Geometry.Rectangle([points.lon.min(), points.lat.min(),
                                 points.lon.max(), points.lat.max()])
    lst = summer_lst(aoi)
    rows: list[dict] = []
    for i in range(0, len(points), CHUNK):
        part = points.iloc[i:i + CHUNK]
        fc = ee.FeatureCollection([
            ee.Feature(ee.Geometry.Point([lon, lat]).buffer(BUFFER_M), {"point_id": pid})
            for pid, lon, lat in zip(part.point_id, part.lon, part.lat)
        ])
        res = lst.reduceRegions(collection=fc, reducer=ee.Reducer.mean(), scale=30).getInfo()
        rows += [{"point_id": f["properties"]["point_id"], "lst_c": f["properties"].get("mean")}
                 for f in res["features"]]
        log.info(f"  sampled {min(i + CHUNK, len(points)):,}/{len(points):,}")
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser(description="Landsat summer LST around each transit point")
    ap.add_argument("--dry-run", action="store_true", help="sample and report, no DB write")
    ap.add_argument("--limit", type=int, help="only the first N points (testing)")
    args = ap.parse_args()

    load_dotenv()
    engine = create_engine(os.environ["DATABASE_URL"])
    points = pd.read_sql(
        "SELECT point_id, ST_X(geom) AS lon, ST_Y(geom) AS lat "
        "FROM derived.transit_points ORDER BY point_id", engine)
    if args.limit:
        points = points.head(args.limit)
    if points.empty:
        raise SystemExit("derived.transit_points is empty — run load_pop_cells.py first")

    init_ee()
    heat = sample(points)
    s = heat.lst_c.describe()
    log.info(f"  LST °C: n={int(s['count'])}/{len(heat)} min={s['min']:.1f} "
             f"median={heat.lst_c.median():.1f} max={s['max']:.1f}")

    if args.dry_run:
        return
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE derived.stop_heat"))
    heat.to_sql("stop_heat", engine, schema="derived", if_exists="append", index=False)
    log.info(f"  ✓ derived.stop_heat: {len(heat):,} rows, {heat.lst_c.isna().sum()} without a clear pixel")


if __name__ == "__main__":
    main()

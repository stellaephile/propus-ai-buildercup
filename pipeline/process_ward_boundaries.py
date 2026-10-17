"""
pipeline/process_ward_boundaries.py
------------------------------------
Ward fixture QA + dissolved outer city boundary.

1. Validates apps/web/public/fixtures/wards.geojson (make_valid). The fixture
   is rewritten ONLY if repairs were needed — currently all 289 polygons are
   valid, so this is a guard, not a churn.
2. Dissolves the wards into the outer city boundary. The raw union carries
   ~586 sliver holes (fixture simplification gaps between neighbouring ward
   edges, all < 60 m wide); a 60 m morphological closing in EPSG:32643 (the
   measurement CRS, CLAUDE.md §3.5) removes them. The two disjoint parts that
   remain (~1352 + ~99 km^2) are real MCD topology and are both kept.
3. Writes apps/web/public/fixtures/city_boundary.geojson — the dashed outline
   the landing shows before any ward-level analysis runs.

Usage: .venv/bin/python pipeline/process_ward_boundaries.py
"""

from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import mapping
from shapely.validation import make_valid

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "apps" / "web" / "public" / "fixtures"
WARDS = FIXTURES / "wards.geojson"
OUT = FIXTURES / "city_boundary.geojson"

CLOSE_M = 60      # sliver-closing radius; every observed gap is narrower
SIMPLIFY_M = 30   # boundary display simplification (§5.4 payload budget)


def round_coords(obj, nd=5):  # noqa: ANN001 — recursive over nested coords
    if isinstance(obj, (int, float)):
        return round(obj, nd)
    return [round_coords(c, nd) for c in obj]


def main() -> int:
    gdf = gpd.read_file(WARDS)
    invalid = ~gdf.is_valid
    if invalid.any():
        print(f"repairing {int(invalid.sum())} invalid ward geometries (make_valid)")
        gdf.geometry = gdf.geometry.apply(make_valid)
        gdf.to_file(WARDS, driver="GeoJSON")
    else:
        print(f"{len(gdf)} ward geometries valid — wards.geojson untouched")

    proj = gdf.to_crs(32643)
    dissolved = proj.union_all().buffer(CLOSE_M).buffer(-CLOSE_M).simplify(SIMPLIFY_M)
    boundary = gpd.GeoSeries([dissolved], crs=32643).to_crs(4326).iloc[0]

    geom = mapping(boundary)
    geom["coordinates"] = round_coords(geom["coordinates"])
    parts = len(geom["coordinates"]) if geom["type"] == "MultiPolygon" else 1
    fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": geom,
            "properties": {
                "name": "Delhi — MCD wards (dissolved)",
                # derived by dissolve + 60 m sliver closing in EPSG:32643
                "evidence": "Calculated",
            },
        }],
    }
    OUT.write_text(json.dumps(fc, separators=(",", ":")))
    print(f"city boundary: {parts} part(s) -> {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

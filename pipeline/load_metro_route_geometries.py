"""
pipeline/load_metro_route_geometries.py
----------------------------------------
Populate derived.route_geometries for METRO routes from gtfs_metro.shapes.

The DMRC feed ships real track geometry in shapes.txt but its trips.txt has
no shape_id column, so the link route -> shape is recovered spatially: for
each route, take one representative trip's ordered stops and pick the shape
polyline with the smallest mean stop-to-shape deviation. Matches are only
accepted under MAX_MEAN_DEVIATION_M — anything worse is skipped and reported
(an honest gap beats a wrong line, CLAUDE.md §3.1). Verified match quality on
the current feed: every route lands within 14–56 m (platform-to-track scale).

Idempotent: upserts on (route_id, feed); source tag 'gtfs_shapes'.

Usage:
    DATABASE_URL in .env (write role — the agent's RO role cannot load this)
    .venv/bin/python pipeline/load_metro_route_geometries.py
"""

from __future__ import annotations

import math
import os
import sys

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv()

MAX_MEAN_DEVIATION_M = 100.0
DEG_TO_M = 111_000  # good enough at Delhi's latitude for a match metric


def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL not set — aborting.", file=sys.stderr)
        return 1
    engine = create_engine(url, pool_pre_ping=True)

    with engine.connect() as conn:
        shape_rows = conn.execute(text(
            "SELECT shape_id, shape_pt_lon, shape_pt_lat FROM gtfs_metro.shapes "
            "ORDER BY shape_id, shape_pt_sequence"
        )).mappings().all()
        shapes: dict[str, list[tuple[float, float]]] = {}
        for r in shape_rows:
            shapes.setdefault(r["shape_id"], []).append((r["shape_pt_lon"], r["shape_pt_lat"]))

        stop_rows = conn.execute(text("""
            SELECT t.route_id, s.stop_lon, s.stop_lat
            FROM (SELECT DISTINCT ON (route_id) route_id, trip_id FROM gtfs_metro.trips) t
            JOIN gtfs_metro.stop_times st ON st.trip_id = t.trip_id
            JOIN gtfs_metro.stops s       ON s.stop_id  = st.stop_id
        """)).mappings().all()
        route_stops: dict[str, list[tuple[float, float]]] = {}
        for r in stop_rows:
            route_stops.setdefault(r["route_id"], []).append((r["stop_lon"], r["stop_lat"]))

    if not shapes or not route_stops:
        print("No metro shapes or stops found — nothing to do.", file=sys.stderr)
        return 1

    def mean_deviation_m(stops: list[tuple[float, float]], pts: list[tuple[float, float]]) -> float:
        def d(a: tuple[float, float], b: tuple[float, float]) -> float:
            return math.hypot(a[0] - b[0], a[1] - b[1])
        return sum(min(d(s, p) for p in pts) for s in stops) / len(stops) * DEG_TO_M

    matched: dict[str, str] = {}
    skipped: list[tuple[str, float]] = []
    for route_id, stops in sorted(route_stops.items()):
        best = min(shapes, key=lambda sid: mean_deviation_m(stops, shapes[sid]))
        dev = mean_deviation_m(stops, shapes[best])
        if dev <= MAX_MEAN_DEVIATION_M:
            matched[route_id] = best
            print(f"{route_id} -> {best} ({dev:.0f} m)")
        else:
            skipped.append((route_id, dev))
            print(f"{route_id}: best match {best} at {dev:.0f} m exceeds "
                  f"{MAX_MEAN_DEVIATION_M:.0f} m — skipped", file=sys.stderr)

    with engine.begin() as conn:
        for route_id, shape_id in matched.items():
            conn.execute(text("""
                INSERT INTO derived.route_geometries (route_id, feed, source, geom)
                SELECT :route_id, 'metro', 'gtfs_shapes',
                       ST_MakeLine(ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326)
                                   ORDER BY shape_pt_sequence)
                FROM gtfs_metro.shapes WHERE shape_id = :shape_id
                ON CONFLICT (route_id, feed) DO UPDATE
                    SET source = EXCLUDED.source, geom = EXCLUDED.geom
            """), {"route_id": route_id, "shape_id": shape_id})

    print(f"Loaded {len(matched)} metro route geometries "
          f"({len(skipped)} skipped over threshold).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

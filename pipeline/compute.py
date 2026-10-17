"""
compute.py
----------
Computes derived transit metrics per ward from GTFS data in PostGIS.
Updates derived.ward_metrics table.

Metrics computed:
  - bus_stop_count, metro_stop_count per ward  (ST_Within)
  - area_sq_km, stop_density_per_km2            (EPSG:32643 area; stops/km2)
  - bus_route_count, metro_route_count per ward
  - peak_freq_mean, offpeak_freq_mean           (trips/hr per stop)
  - has_metro_within_1k                         (boolean per ward)
  - multimodal_gap_count                        (bus stops with no metro within 1km)
  - transit_score                               (0–1 composite, pre-RS version;
                                                  stops term is area-normalised)

Usage:
    python pipeline/compute.py

Requires:
    DATABASE_URL in .env
    schema.sql applied
    ingest.py completed
"""

import os
import logging
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

DATABASE_URL = os.environ["DATABASE_URL"]

# Peak hours in seconds from midnight
PEAK_AM_START  = 7  * 3600   # 07:00
PEAK_AM_END    = 10 * 3600   # 10:00
PEAK_PM_START  = 17 * 3600   # 17:00
PEAK_PM_END    = 20 * 3600   # 20:00
PEAK_DURATION  = 3.0         # hours (AM window = 3h, PM window = 3h)

OFFPEAK_START  = 10 * 3600   # 10:00
OFFPEAK_END    = 16 * 3600   # 16:00
OFFPEAK_HOURS  = 6.0

# Distance threshold for multimodal gap analysis (metres)
METRO_GAP_METRES = 1000


def run(engine, label: str, sql: str, params: dict = None):
    """Execute a SQL statement, log rows affected."""
    log.info(f"  {label}...")
    with engine.connect() as conn:
        result = conn.execute(text(sql), params or {})
        conn.commit()
        log.info(f"  ✓ {label}: {result.rowcount} rows updated")


def compute_stop_counts(engine):
    """
    Count bus and metro stops within each ward polygon using ST_Within.

    Bus stops are counted at THREE levels, because "how many stops" has three
    legitimate answers and conflating them is what inflated every density metric
    ~2.6x (see derived.stop_clusters and pipeline/cluster_stops.py):

      bus_stop_count            raw stop_id      one row per (pole x route)
      bus_boarding_point_count  stop_code        one row per pole   [Observed]
      bus_physical_stop_count   physical_stop_id one row per LOCATION [Estimated]

    bus_stop_count is retained for continuity with existing agent tools but is
    NOT the right numerator for density: it counts the same physical pole once
    per serving route, and counts the to/from pair either side of a road twice.
    Ward-level inflation is not uniform (1.0x to 11.0x, sigma 0.96), so it does
    not cancel out of a ranking — 4 of the top-10 densest wards change.

    Stops are joined to the crosswalk by stop_id. A stop with no crosswalk row
    is counted at its own location rather than dropped, so a partial crosswalk
    degrades toward the old behaviour instead of silently under-counting.
    """

    run(engine, "Bus stop count per ward (legacy, raw stop_id)", f"""
        UPDATE derived.ward_metrics wm
        SET bus_stop_count = subq.cnt
        FROM (
            SELECT w.ward_id, COUNT(s.stop_id) AS cnt
            FROM public.wards w
            LEFT JOIN gtfs_bus.stops s
                ON ST_Within(s.geom, w.geometry)
                AND s.location_type = 0
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    run(engine, "Bus boarding points per ward (Observed, distinct stop_code)", f"""
        UPDATE derived.ward_metrics wm
        SET bus_boarding_point_count = subq.cnt
        FROM (
            SELECT w.ward_id,
                   COUNT(DISTINCT COALESCE(s.stop_code, s.stop_id)) AS cnt
            FROM public.wards w
            LEFT JOIN gtfs_bus.stops s
                ON ST_Within(s.geom, w.geometry)
                AND s.location_type = 0
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    # Physical stops are assigned to a ward by their CLUSTER CENTROID, not by
    # each member pole's own geometry. Otherwise a cluster straddling a ward
    # boundary would be counted once in each ward — inflating exactly the metric
    # this column exists to fix. One location, one ward.
    run(engine, "Bus physical stops per ward (Estimated, clustered @40m)", f"""
        UPDATE derived.ward_metrics wm
        SET bus_physical_stop_count = subq.cnt
        FROM (
            SELECT w.ward_id, COUNT(DISTINCT c.physical_stop_id) AS cnt
            FROM public.wards w
            LEFT JOIN (
                SELECT DISTINCT
                       sc.physical_stop_id,
                       ST_SetSRID(ST_MakePoint(sc.centroid_lon, sc.centroid_lat), 4326) AS geom
                FROM derived.stop_clusters sc
                JOIN gtfs_bus.stops s ON s.stop_id = sc.stop_id
                WHERE s.location_type = 0
            ) c ON ST_Within(c.geom, w.geometry)
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    run(engine, "Metro stop count per ward", f"""
        UPDATE derived.ward_metrics wm
        SET metro_stop_count = subq.cnt
        FROM (
            SELECT w.ward_id, COUNT(s.stop_id) AS cnt
            FROM public.wards w
            LEFT JOIN gtfs_metro.stops s
                ON ST_Within(s.geom, w.geometry)
                AND s.location_type = 0
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    run(engine, "Total stop count", """
        UPDATE derived.ward_metrics
        SET total_stop_count = bus_stop_count + metro_stop_count
    """)


def compute_ward_area(engine):
    """
    Ward polygon area and the stop-density metric it backs.

    Area is computed in EPSG:32643 (UTM 43N), never in the source geographic
    CRS (EPSG:4326) — degrees aren't a unit of area, per CLAUDE.md §3.5.
    stop_density_per_km2 lets transit_score reward wards that are actually
    well-served per unit area, rather than wards that just happen to be
    large and so accumulate more stops in absolute terms.
    """

    run(engine, "Ward area (EPSG:32643)", """
        UPDATE derived.ward_metrics wm
        SET area_sq_km = ST_Area(ST_Transform(w.geometry, 32643)) / 1e6
        FROM public.wards w
        WHERE wm.ward_id = w.ward_id
    """)

    run(engine, "Stop density per km2 (legacy, raw stop_id)", """
        UPDATE derived.ward_metrics
        SET stop_density_per_km2 = total_stop_count / NULLIF(area_sq_km, 0)
    """)

    # The de-double-counted density. Physical bus stop LOCATIONS + metro
    # stations, per km2. Metro needs no clustering: 262 stations, 262 distinct
    # names, zero duplication in the feed.
    run(engine, "Physical stop density per km2 (Estimated)", """
        UPDATE derived.ward_metrics
        SET physical_stop_density_per_km2 =
            (COALESCE(bus_physical_stop_count, 0) + COALESCE(metro_stop_count, 0))
            / NULLIF(area_sq_km, 0)
    """)

def compute_route_counts(engine):
    """
    Count distinct routes serving each ward.
    A route 'serves' a ward if it has at least one stop within that ward.

    Bus route membership comes from derived.route_stops (route_id, stop_id)
    rather than a live gtfs_bus.stop_times join — that raw table is
    deliberately absent from schema.sql (see precompute_route_aggregates.py).
    """

    # LEFT JOINs throughout so wards with zero routes get 0, not NULL —
    # an INNER JOIN would silently drop those wards from subq and leave
    # bus_route_count NULL, which then poisons transit_score's sum downstream.
    run(engine, "Bus route count per ward", """
        UPDATE derived.ward_metrics wm
        SET bus_route_count = subq.cnt
        FROM (
            SELECT w.ward_id, COUNT(DISTINCT rs.route_id) AS cnt
            FROM public.wards w
            LEFT JOIN gtfs_bus.stops s ON ST_Within(s.geom, w.geometry)
            LEFT JOIN derived.route_stops rs ON rs.stop_id = s.stop_id AND rs.feed = 'bus'
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    run(engine, "Metro route count per ward", """
        UPDATE derived.ward_metrics wm
        SET metro_route_count = subq.cnt
        FROM (
            SELECT w.ward_id, COUNT(DISTINCT t.route_id) AS cnt
            FROM public.wards w
            LEFT JOIN gtfs_metro.stops s ON ST_Within(s.geom, w.geometry)
            LEFT JOIN gtfs_metro.stop_times st ON st.stop_id = s.stop_id
            LEFT JOIN gtfs_metro.trips t ON t.trip_id = st.trip_id
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)


def compute_service_frequency(engine):
    """
    Compute average service frequency per stop per ward.

    Method:
      1. For each stop in a ward, sum scheduled trip counts (from
         derived.stop_hourly_frequency) across the hour buckets covering the
         peak / off-peak window.
      2. Divide by the window duration in hours → trips/hour per stop.
      3. Average across all stops in the ward.

    Uses derived.stop_hourly_frequency instead of a live gtfs_bus.stop_times
    join — that raw table is deliberately absent from schema.sql (see
    precompute_route_aggregates.py). The bus feed's single calendar service
    (bus_1) runs all 7 days, so hourly counts already reflect weekday
    service without a separate calendar filter.
    """

    peak_hours = list(range(PEAK_AM_START // 3600, PEAK_AM_END // 3600))
    offpeak_hours = list(range(OFFPEAK_START // 3600, OFFPEAK_END // 3600))

    # Peak AM frequency (07:00–10:00)
    run(engine, "Peak AM frequency per ward (bus)", f"""
        UPDATE derived.ward_metrics wm
        SET peak_freq_mean = subq.freq
        FROM (
            SELECT w.ward_id,
                   AVG(stop_trips.trip_count::float / {PEAK_DURATION}) AS freq
            FROM public.wards w
            JOIN gtfs_bus.stops s ON ST_Within(s.geom, w.geometry)
            LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(f.trip_count), 0) AS trip_count
                FROM derived.stop_hourly_frequency f
                WHERE f.stop_id = s.stop_id
                  AND f.feed = 'bus'
                  AND f.hour_of_day = ANY(ARRAY{peak_hours})
            ) stop_trips ON TRUE
            WHERE s.location_type = 0
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    # Off-peak frequency (10:00–16:00)
    run(engine, "Off-peak frequency per ward (bus)", f"""
        UPDATE derived.ward_metrics wm
        SET offpeak_freq_mean = subq.freq
        FROM (
            SELECT w.ward_id,
                   AVG(stop_trips.trip_count::float / {OFFPEAK_HOURS}) AS freq
            FROM public.wards w
            JOIN gtfs_bus.stops s ON ST_Within(s.geom, w.geometry)
            LEFT JOIN LATERAL (
                SELECT COALESCE(SUM(f.trip_count), 0) AS trip_count
                FROM derived.stop_hourly_frequency f
                WHERE f.stop_id = s.stop_id
                  AND f.feed = 'bus'
                  AND f.hour_of_day = ANY(ARRAY{offpeak_hours})
            ) stop_trips ON TRUE
            WHERE s.location_type = 0
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)


def compute_metro_proximity(engine):
    """
    Flag wards where at least one metro station is within 1km of any point
    inside the ward polygon (using ST_DWithin on geography for metre accuracy).
    """

    run(engine, f"Metro within {METRO_GAP_METRES}m flag per ward", f"""
        UPDATE derived.ward_metrics wm
        SET has_metro_within_1k = subq.has_metro
        FROM (
            SELECT w.ward_id,
                   EXISTS (
                       SELECT 1
                       FROM gtfs_metro.stops ms
                       WHERE ms.location_type = 0
                         AND ST_DWithin(
                             w.geometry::geography,
                             ms.geom::geography,
                             {METRO_GAP_METRES}
                         )
                   ) AS has_metro
            FROM public.wards w
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)


def compute_multimodal_gaps(engine):
    """
    Count bus stops within each ward that have NO metro stop within 1km.
    These are the 'multimodal gap' stops — served by bus but not within
    walking distance of any metro station.
    High count = ward is bus-dependent with no metro connectivity.
    """

    run(engine, "Multimodal gap count per ward", f"""
        UPDATE derived.ward_metrics wm
        SET multimodal_gap = subq.gap_count > 0
        FROM (
            SELECT w.ward_id,
                   COUNT(bs.stop_id) AS gap_count
            FROM public.wards w
            JOIN gtfs_bus.stops bs ON ST_Within(bs.geom, w.geometry)
            WHERE bs.location_type = 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM gtfs_metro.stops ms
                  WHERE ms.location_type = 0
                    AND ST_DWithin(
                        bs.geom::geography,
                        ms.geom::geography,
                        {METRO_GAP_METRES}
                    )
              )
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)

    # Also store the raw count for ranking
    run(engine, "Multimodal gap stop count per ward", f"""
        ALTER TABLE derived.ward_metrics
        ADD COLUMN IF NOT EXISTS multimodal_gap_count INTEGER DEFAULT 0
    """)

    run(engine, "Populate multimodal_gap_count", f"""
        UPDATE derived.ward_metrics wm
        SET multimodal_gap_count = subq.gap_count
        FROM (
            SELECT w.ward_id,
                   COUNT(bs.stop_id) AS gap_count
            FROM public.wards w
            JOIN gtfs_bus.stops bs ON ST_Within(bs.geom, w.geometry)
            WHERE bs.location_type = 0
              AND NOT EXISTS (
                  SELECT 1
                  FROM gtfs_metro.stops ms
                  WHERE ms.location_type = 0
                    AND ST_DWithin(
                        bs.geom::geography,
                        ms.geom::geography,
                        {METRO_GAP_METRES}
                    )
              )
            GROUP BY w.ward_id
        ) subq
        WHERE wm.ward_id = subq.ward_id
    """)


def compute_transit_score(engine):
    """
    Compute a composite transit accessibility score per ward (0–1).

    This is the pre-RS version — uses only GTFS metrics.
    It will be revised by rs_merge.py once WorldPop and Sentinel-2 data
    are loaded.

    NOT an official/published formula — a prototype composite. The
    coverage+frequency+route structure follows the general approach used in
    published transit-accessibility-index literature (e.g. "A Composite
    Index of Public Transit Accessibility",
    sciencedirect.com/science/article/pii/S1077291X22001965 — coverage,
    frequency, and route-coverage sub-scores, standardized and weighted).
    The specific weights below are team defaults, not calibrated to Delhi
    ridership or survey data — say so whenever this score is presented.

    Formula (equal weights for prototype, tune later):
        score = 0.35 * norm(stop_density_per_km2)
              + 0.25 * norm(peak_freq_mean)
              + 0.20 * norm(bus_route_count + metro_route_count)
              + 0.20 * has_metro_within_1k::int

    The stops term is area-normalised (stop_density_per_km2, from
    compute_ward_area — run before this), not a raw stop count: a
    large ward and a compact one with the same stop count are not
    equally well served, and a raw count rewarded the large one anyway.

    Normalisation: min-max per column across all wards.
    Result stored in transit_score.
    """

    # Step 1: compute normalised sub-scores in a CTE, then write
    run(engine, "Transit score (GTFS composite)", """
        WITH bounds AS (
            SELECT
                MIN(COALESCE(stop_density_per_km2, 0)) AS min_density,
                MAX(COALESCE(stop_density_per_km2, 0)) AS max_density,
                MIN(COALESCE(peak_freq_mean, 0))        AS min_freq,
                MAX(COALESCE(peak_freq_mean, 0))        AS max_freq,
                MIN(bus_route_count + metro_route_count) AS min_routes,
                MAX(bus_route_count + metro_route_count) AS max_routes
            FROM derived.ward_metrics
        ),
        normed AS (
            SELECT
                wm.ward_id,
                CASE WHEN b.max_density > b.min_density
                     THEN (COALESCE(wm.stop_density_per_km2,0) - b.min_density)::float
                          / (b.max_density - b.min_density)
                     ELSE 0 END AS n_density,

                CASE WHEN b.max_freq   > b.min_freq
                     THEN (COALESCE(wm.peak_freq_mean,0) - b.min_freq)::float
                          / (b.max_freq - b.min_freq)
                     ELSE 0 END AS n_freq,

                CASE WHEN b.max_routes > b.min_routes
                     THEN ((wm.bus_route_count + wm.metro_route_count) - b.min_routes)::float
                          / (b.max_routes - b.min_routes)
                     ELSE 0 END AS n_routes,

                COALESCE(wm.has_metro_within_1k::int, 0)::float AS n_metro

            FROM derived.ward_metrics wm
            CROSS JOIN bounds b
        )
        UPDATE derived.ward_metrics wm
        SET transit_score = ROUND(
            (0.35 * n.n_density
           + 0.25 * n.n_freq
           + 0.20 * n.n_routes
           + 0.20 * n.n_metro)::numeric,
        4)
        FROM normed n
        WHERE wm.ward_id = n.ward_id
    """)


def log_summary(engine):
    """Print a ranked summary of the 10 worst and 10 best served wards."""
    log.info("\n── Transit score summary ──")

    with engine.connect() as conn:
        # Top 10 worst
        worst = conn.execute(text("""
            SELECT ward_name, total_stop_count, peak_freq_mean,
                   has_metro_within_1k, transit_score
            FROM derived.ward_metrics
            ORDER BY transit_score ASC NULLS LAST
            LIMIT 10
        """)).fetchall()

        log.info("\n  10 worst-served wards:")
        log.info(f"  {'Ward':<30} {'Stops':>6} {'Freq/hr':>8} {'Metro':>6} {'Score':>7}")
        log.info("  " + "-" * 62)
        for row in worst:
            metro = "Yes" if row[3] else "No"
            freq  = f"{row[2]:.2f}" if row[2] is not None else "N/A"
            score = f"{row[4]:.4f}" if row[4] is not None else "N/A"
            log.info(f"  {row[0]:<30} {row[1]:>6} {freq:>8} {metro:>6} {score:>7}")

        # Top 10 best
        best = conn.execute(text("""
            SELECT ward_name, total_stop_count, peak_freq_mean,
                   has_metro_within_1k, transit_score
            FROM derived.ward_metrics
            ORDER BY transit_score DESC NULLS LAST
            LIMIT 10
        """)).fetchall()

        log.info("\n  10 best-served wards:")
        log.info(f"  {'Ward':<30} {'Stops':>6} {'Freq/hr':>8} {'Metro':>6} {'Score':>7}")
        log.info("  " + "-" * 62)
        for row in best:
            metro = "Yes" if row[3] else "No"
            freq  = f"{row[2]:.2f}" if row[2] is not None else "N/A"
            score = f"{row[4]:.4f}" if row[4] is not None else "N/A"
            log.info(f"  {row[0]:<30} {row[1]:>6} {freq:>8} {metro:>6} {score:>7}")


def verify(engine):
    """Quick null-check on derived.ward_metrics."""
    log.info("\n── Verification ──")
    checks = [
        ("bus_stop_count",    "IS NOT NULL"),
        ("bus_boarding_point_count", "IS NOT NULL"),
        ("bus_physical_stop_count",  "IS NOT NULL"),
        ("physical_stop_density_per_km2", "IS NOT NULL"),
        ("transit_score",     "IS NOT NULL"),
        ("has_metro_within_1k","IS NOT NULL"),
        ("peak_freq_mean",    "IS NOT NULL"),
    ]
    with engine.connect() as conn:
        for col, condition in checks:
            populated = conn.execute(
                text(f"SELECT COUNT(*) FROM derived.ward_metrics WHERE {col} {condition}")
            ).scalar()
            total = conn.execute(
                text("SELECT COUNT(*) FROM derived.ward_metrics")
            ).scalar()
            pct = populated / total * 100 if total else 0
            status = "✓" if populated == total else f"⚠ {total - populated} nulls"
            log.info(f"  {status}  {col}: {populated}/{total} ({pct:.0f}%)")


def main():
    log.info("=" * 60)
    log.info("Propus — Derived Metrics Compute Script")
    log.info("=" * 60)

    engine = create_engine(DATABASE_URL, pool_pre_ping=True)

    log.info("\n── Step 1: Stop counts ──")
    compute_stop_counts(engine)

    log.info("\n── Step 2: Ward area & stop density ──")
    compute_ward_area(engine)

    log.info("\n── Step 3: Route counts ──")
    compute_route_counts(engine)

    log.info("\n── Step 4: Service frequency ──")
    compute_service_frequency(engine)

    log.info("\n── Step 5: Metro proximity ──")
    compute_metro_proximity(engine)

    log.info("\n── Step 6: Multimodal gaps ──")
    compute_multimodal_gaps(engine)

    log.info("\n── Step 7: Transit score ──")
    compute_transit_score(engine)

    log.info("\n── Step 8: Verification ──")
    verify(engine)
    log_summary(engine)

    log.info("\n" + "=" * 60)
    log.info("✓ compute.py complete. GTFS-derived metrics ready.")
    log.info("  Next: python pipeline/rs_worldpop.py")
    log.info("=" * 60)


if __name__ == "__main__":
    main()

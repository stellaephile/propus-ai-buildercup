-- ============================================================================
-- Propus — Delhi Transit Intelligence
-- schema.sql — full DDL, reverse-engineered from pipeline/*.py and
-- agent/agent.py's SQL (no schema.sql ever existed in this repo's history;
-- this was built by reading every CREATE/ALTER/SELECT/UPDATE statement in
-- pipeline/ingest.py, compute.py, rs_worldpop.py, rs_sentinel.py, rs_merge.py,
-- fetch_osm_routes.py, embed.py, agent/agent.py, mcp_server/server.py,
-- api/main.py -- not copied from a live database).
--
-- Target: Supabase (Postgres + PostGIS), free tier, prototype scale.
-- Per CLAUDE.md §4: only DERIVED data is loaded here. Raw gtfs_bus.stop_times
-- (~3.7M rows, ~450MB+) is intentionally NOT included -- see the
-- derived.route_stops / derived.stop_hourly_frequency aggregate tables below,
-- which replace the two agent tools (get_route_coverage, get_frequency_at_stop)
-- that used to query raw bus stop_times live. gtfs_metro.stop_times (128K rows,
-- ~15MB) is small enough to keep as-is.
--
-- CRS: all geometry is stored in EPSG:4326 (WGS84). Area/distance math that
-- needs a projected CRS (EPSG:32643, UTM 43N) happens at query time via
-- ::geography casts or explicit ST_Transform, per CLAUDE.md §3.5.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;   -- optional: only needed for semantic_stop_search's pgvector path

CREATE SCHEMA IF NOT EXISTS gtfs_bus;
CREATE SCHEMA IF NOT EXISTS gtfs_metro;
CREATE SCHEMA IF NOT EXISTS derived;
CREATE SCHEMA IF NOT EXISTS embeddings;
-- public schema is Postgres's default; used for wards + Supabase-managed objects.

-- ----------------------------------------------------------------------------
-- Shared trigger: auto-set geom from stop_lat/stop_lon on INSERT/UPDATE.
-- ingest.py's comment confirms this trigger existed and that its own
-- to_sql()/COPY bulk-load path bypasses it (hence the manual
-- "UPDATE ... SET geom = ST_SetSRID(...)" call after each bulk load).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_stop_geom() RETURNS trigger AS $$
BEGIN
    IF NEW.stop_lat IS NOT NULL AND NEW.stop_lon IS NOT NULL THEN
        NEW.geom := ST_SetSRID(ST_MakePoint(NEW.stop_lon, NEW.stop_lat), 4326);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- GTFS feeds (bus = DTC, metro = DMRC) — identical structure per feed.
-- All IDs are feed-prefixed at ingest time ('bus_<n>' / 'metro_<n>') to avoid
-- collisions across the two source feeds sharing numeric ranges.
-- ============================================================================

-- ---------- stops ----------
CREATE TABLE IF NOT EXISTS gtfs_bus.stops (
    stop_id       TEXT PRIMARY KEY,
    -- OTD Delhi publishes stop_code as the PHYSICAL boarding-point key: 10,559
    -- stop_id rows collapse to 6,880 stop_codes, and every stop_code maps to
    -- exactly one (lat, lon, stop_name). The surplus rows are the same pole
    -- listed once per serving route. Counting stop_id therefore double-counts
    -- boarding points; see derived.stop_clusters.
    stop_code     TEXT,
    stop_name     TEXT NOT NULL,
    stop_lat      DOUBLE PRECISION NOT NULL,
    stop_lon      DOUBLE PRECISION NOT NULL,
    location_type SMALLINT DEFAULT 0,
    feed          TEXT NOT NULL DEFAULT 'bus',
    geom          GEOMETRY(POINT, 4326)
);
CREATE INDEX IF NOT EXISTS idx_gtfs_bus_stops_geom ON gtfs_bus.stops USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_gtfs_bus_stops_code ON gtfs_bus.stops (stop_code);
CREATE TRIGGER trg_gtfs_bus_stops_geom
    BEFORE INSERT OR UPDATE ON gtfs_bus.stops
    FOR EACH ROW EXECUTE FUNCTION set_stop_geom();

CREATE TABLE IF NOT EXISTS gtfs_metro.stops (
    stop_id       TEXT PRIMARY KEY,
    -- OTD Delhi publishes stop_code as the PHYSICAL boarding-point key: 10,559
    -- stop_id rows collapse to 6,880 stop_codes, and every stop_code maps to
    -- exactly one (lat, lon, stop_name). The surplus rows are the same pole
    -- listed once per serving route. Counting stop_id therefore double-counts
    -- boarding points; see derived.stop_clusters.
    stop_code     TEXT,
    stop_name     TEXT NOT NULL,
    stop_lat      DOUBLE PRECISION NOT NULL,
    stop_lon      DOUBLE PRECISION NOT NULL,
    location_type SMALLINT DEFAULT 0,
    feed          TEXT NOT NULL DEFAULT 'metro',
    geom          GEOMETRY(POINT, 4326)
);
CREATE INDEX IF NOT EXISTS idx_gtfs_metro_stops_geom ON gtfs_metro.stops USING GIST (geom);
CREATE TRIGGER trg_gtfs_metro_stops_geom
    BEFORE INSERT OR UPDATE ON gtfs_metro.stops
    FOR EACH ROW EXECUTE FUNCTION set_stop_geom();

-- ---------- routes ----------
-- Note: route_short_name is empty for the whole Delhi bus feed (route number
-- is embedded in route_long_name instead) -- see status/gtfs_overview.md.
CREATE TABLE IF NOT EXISTS gtfs_bus.routes (
    route_id         TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name  TEXT,
    route_type       SMALLINT,
    feed             TEXT NOT NULL DEFAULT 'bus'
);

CREATE TABLE IF NOT EXISTS gtfs_metro.routes (
    route_id         TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name  TEXT,
    route_type       SMALLINT,
    feed             TEXT NOT NULL DEFAULT 'metro'
);

-- ---------- trips ----------
CREATE TABLE IF NOT EXISTS gtfs_bus.trips (
    trip_id      TEXT PRIMARY KEY,
    route_id     TEXT NOT NULL REFERENCES gtfs_bus.routes(route_id),
    service_id   TEXT,
    direction_id SMALLINT,
    feed         TEXT NOT NULL DEFAULT 'bus'
);
CREATE INDEX IF NOT EXISTS idx_gtfs_bus_trips_route ON gtfs_bus.trips (route_id);

CREATE TABLE IF NOT EXISTS gtfs_metro.trips (
    trip_id      TEXT PRIMARY KEY,
    route_id     TEXT NOT NULL REFERENCES gtfs_metro.routes(route_id),
    service_id   TEXT,
    direction_id SMALLINT,
    feed         TEXT NOT NULL DEFAULT 'metro'
);
CREATE INDEX IF NOT EXISTS idx_gtfs_metro_trips_route ON gtfs_metro.trips (route_id);

-- ---------- stop_times ----------
-- gtfs_bus.stop_times is DELIBERATELY NOT created here -- ~3.7M rows would
-- blow the Supabase free tier alone. Its content lives only in
-- data/processed/bus/stop_times.csv locally, and was precomputed at build
-- time into derived.route_stops + derived.stop_hourly_frequency below.
-- If you need the raw table for a future paid tier, mirror gtfs_metro.stop_times
-- below with feed defaulted to 'bus'.

CREATE TABLE IF NOT EXISTS gtfs_metro.stop_times (
    trip_id            TEXT NOT NULL REFERENCES gtfs_metro.trips(trip_id),
    stop_id             TEXT NOT NULL REFERENCES gtfs_metro.stops(stop_id),
    arrival_time        TEXT,      -- GTFS HH:MM:SS, may exceed 24:00:00 for overnight service
    departure_time      TEXT,
    arrival_seconds     INTEGER,   -- precomputed for fast range queries
    departure_seconds   INTEGER,
    stop_sequence       INTEGER NOT NULL,
    feed                TEXT NOT NULL DEFAULT 'metro'
);
CREATE INDEX IF NOT EXISTS idx_gtfs_metro_stop_times_stop ON gtfs_metro.stop_times (stop_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_metro_stop_times_trip ON gtfs_metro.stop_times (trip_id);
CREATE INDEX IF NOT EXISTS idx_gtfs_metro_stop_times_arr  ON gtfs_metro.stop_times (arrival_seconds);

-- ---------- shapes (optional -- bus shapes built from OSM, see gtfs_overview.md) ----------
CREATE TABLE IF NOT EXISTS gtfs_bus.shapes (
    shape_id          TEXT NOT NULL,
    shape_pt_lat      DOUBLE PRECISION NOT NULL,
    shape_pt_lon      DOUBLE PRECISION NOT NULL,
    shape_pt_sequence INTEGER NOT NULL,
    feed              TEXT NOT NULL DEFAULT 'bus',
    PRIMARY KEY (shape_id, shape_pt_sequence)
);

CREATE TABLE IF NOT EXISTS gtfs_metro.shapes (
    shape_id          TEXT NOT NULL,
    shape_pt_lat      DOUBLE PRECISION NOT NULL,
    shape_pt_lon      DOUBLE PRECISION NOT NULL,
    shape_pt_sequence INTEGER NOT NULL,
    feed              TEXT NOT NULL DEFAULT 'metro',
    PRIMARY KEY (shape_id, shape_pt_sequence)
);

-- ---------- calendar (optional; calendar_dates.txt absent from both source feeds) ----------
CREATE TABLE IF NOT EXISTS gtfs_bus.calendar (
    service_id TEXT PRIMARY KEY,
    monday     SMALLINT DEFAULT 0,
    tuesday    SMALLINT DEFAULT 0,
    wednesday  SMALLINT DEFAULT 0,
    thursday   SMALLINT DEFAULT 0,
    friday     SMALLINT DEFAULT 0,
    saturday   SMALLINT DEFAULT 0,
    sunday     SMALLINT DEFAULT 0,
    start_date DATE,
    end_date   DATE,
    feed       TEXT NOT NULL DEFAULT 'bus'
);

CREATE TABLE IF NOT EXISTS gtfs_metro.calendar (
    service_id TEXT PRIMARY KEY,
    monday     SMALLINT DEFAULT 0,
    tuesday    SMALLINT DEFAULT 0,
    wednesday  SMALLINT DEFAULT 0,
    thursday   SMALLINT DEFAULT 0,
    friday     SMALLINT DEFAULT 0,
    saturday   SMALLINT DEFAULT 0,
    sunday     SMALLINT DEFAULT 0,
    start_date DATE,
    end_date   DATE,
    feed       TEXT NOT NULL DEFAULT 'metro'
);

-- ============================================================================
-- Ward boundaries (public.wards) — 290 MCD ward polygons, OpenCity/DataMeet
-- source per ATTRIBUTION.md. ingest.py drops+recreates this table wholesale
-- on every run (DROP TABLE ... CASCADE then geopandas to_postgis), so its
-- geometry column is literally named "geometry", not "geom" -- this tripped
-- up ingest.py's own verify step once (status/day2_summary.md Bug 4). Kept
-- as-is here for compatibility with every existing query in agent.py /
-- mcp_server/server.py that reads w.geometry.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wards (
    ward_id  TEXT PRIMARY KEY,
    ward_name TEXT NOT NULL,
    district  TEXT,
    geometry  GEOMETRY(MULTIPOLYGON, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wards_geom ON public.wards USING GIST (geometry);

-- ============================================================================
-- derived.ward_metrics — the table nearly every agent tool reads from.
-- One row per ward, columns added incrementally across compute.py,
-- rs_worldpop.py, rs_sentinel.py, and rs_merge.py (see comments per column).
-- ============================================================================

CREATE TABLE IF NOT EXISTS derived.ward_metrics (
    ward_id                      TEXT PRIMARY KEY REFERENCES public.wards(ward_id),
    ward_name                    TEXT,

    -- from pipeline/compute.py Step 1-2 (GTFS stop/route counts, ST_Within)
    bus_stop_count               INTEGER,   -- LEGACY: raw stop_id rows. Retained
                                            -- for continuity but ~2.6x inflated
                                            -- vs physical stops. Prefer
                                            -- bus_physical_stop_count below.
    bus_boarding_point_count     INTEGER,   -- DISTINCT stop_code (Observed).
                                            -- Lossless: one row per real pole.
    bus_physical_stop_count      INTEGER,   -- DISTINCT physical_stop_id from
                                            -- derived.stop_clusters (Estimated;
                                            -- 40 m complete-linkage). Merges the
                                            -- to/from pair either side of a road
                                            -- into one stop LOCATION. This is the
                                            -- correct numerator for density and
                                            -- coverage metrics.
    metro_stop_count             INTEGER,
    total_stop_count             INTEGER,
    bus_route_count              INTEGER,
    metro_route_count            INTEGER,

    -- from pipeline/compute.py Step 1b (ward polygon area, EPSG:32643 UTM 43N
    -- per CLAUDE.md §3.5 — never computed in geographic degrees). Backs
    -- stop_density_per_km2, which transit_score uses in place of a raw stop
    -- count so a sprawling ward with many stops doesn't outscore a compact,
    -- well-served one.
    area_sq_km                   NUMERIC,
    stop_density_per_km2         NUMERIC,   -- LEGACY: built on bus_stop_count.
    physical_stop_density_per_km2 NUMERIC,  -- bus_physical_stop_count / area_sq_km.
                                            -- The de-double-counted density; the
                                            -- one the ward ranking should use.

    -- from pipeline/compute.py Step 3 (weekday AM peak / off-peak trip frequency)
    peak_freq_mean               NUMERIC,
    offpeak_freq_mean            NUMERIC,

    -- from pipeline/compute.py Step 4-5 (metro proximity, multimodal gaps)
    has_metro_within_1k          BOOLEAN,
    multimodal_gap               BOOLEAN,
    multimodal_gap_count         INTEGER DEFAULT 0,

    -- from pipeline/compute.py Step 6 (pre-RS composite score, 0-1)
    transit_score                NUMERIC,

    -- from pipeline/rs_worldpop.py (WorldPop 2020 zonal population)
    pop_total                    INTEGER,
    stops_per_10k                NUMERIC,   -- (bus_stop_count / pop_total) * 10000, WRI equity metric

    -- from pipeline/rs_sentinel.py (Sentinel-2 zonal NDVI/NDBI via GEE)
    ndvi_mean                    NUMERIC,
    ndbi_mean                    NUMERIC,

    -- from pipeline/rs_merge.py (final composite, requires the above two blocks)
    urban_stress_index           NUMERIC,   -- mean of 3 normalised components, 0-1; >0.7 = critical
    revised_accessibility_score  NUMERIC    -- transit_score * (1 - 0.3 * urban_stress_index)
);

-- ============================================================================
-- derived.route_geometries — route line geometry for map rendering.
-- CONFIRMED as a plain table, not a materialized view: fetch_osm_routes.py's
-- own migration code runs `DROP MATERIALIZED VIEW IF EXISTS
-- derived.route_geometries CASCADE` before creating this table, meaning an
-- earlier schema.sql defined it as a matview and that was deliberately
-- replaced. pipeline/ingest.py still calls `REFRESH MATERIALIZED VIEW
-- derived.route_geometries` in refresh_route_geometries() -- that call is
-- now STALE against this schema and will error; drop/update that call when
-- porting ingest.py to Supabase (tracked under task B2.5 / A4 follow-up).
-- ============================================================================

CREATE TABLE IF NOT EXISTS derived.route_geometries (
    route_id TEXT NOT NULL,
    feed     TEXT NOT NULL,
    source   TEXT,             -- 'osm' | 'fallback_stop_sequence'
    geom     GEOMETRY(GEOMETRY, 4326),
    PRIMARY KEY (route_id, feed)
);
CREATE INDEX IF NOT EXISTS idx_route_geom_gist ON derived.route_geometries USING GIST (geom);

-- ============================================================================
-- derived.stop_clusters — the physical-stop crosswalk (CLAUDE.md §5 rule 1:
-- deterministic geo precomputed upstream, served from a derived table).
--
-- WHY THIS EXISTS. The OTD Delhi bus feed publishes neither parent_station nor
-- location_type, so GTFS's own mechanism for grouping boarding points into a
-- station is absent. Counting raw stop_id therefore triple-counts in two
-- distinct ways, which this table separates:
--
--   stop_id           10,559   one row per (pole x serving route)
--   stop_code          6,880   one row per PHYSICAL POLE          [Observed]
--   physical_stop_id  ~4,388   one row per STOP LOCATION          [Estimated]
--
-- The stop_code collapse is lossless -- every stop_code maps to exactly one
-- (lat, lon, stop_name). The physical_stop_id collapse is a spatial judgement:
-- it merges the two poles either side of a road (median separation 20.4 m; 97%
-- of 2-member clusters) into one location, because their 500 m walk catchments
-- overlap 97.4% -- the second pole adds ~3% coverage while doubling the
-- numerator of every density metric. It is tagged Estimated, never Observed.
--
-- METHOD. Complete-linkage agglomerative clustering, 40 m distance threshold,
-- computed in EPSG:32643 (UTM 43N) per CLAUDE.md §3.5. Complete linkage is
-- deliberate: PostGIS's ST_ClusterDBSCAN / ST_ClusterWithin are single-linkage
-- and chain along corridors (max cluster diameter 182 m at a 50 m eps, vs 61 m
-- for complete linkage on this feed) -- an unbounded blob cannot honestly be
-- called one stop. Complete linkage guarantees diameter <= threshold.
--
-- The 40 m threshold is calibrated, not guessed: identical-name stop pairs sit
-- at a median 20.4 m apart (the directional-pair signature), and 40 m is well
-- under half the typical 200-300 m Delhi bus-stop spacing, so it cannot merge
-- two genuinely distinct stops. stop_name is deliberately NOT used as a merge
-- gate -- the feed's transliteration is inconsistent in both directions
-- ("Safiyabad Crossing"/"shafiabad more" are one place; "Prem Nagar" is 20
-- different places, p99 separation 2.6 km). Names are a QA signal only.
--
-- Written by pipeline/cluster_stops.py.
-- ============================================================================

CREATE TABLE IF NOT EXISTS derived.stop_clusters (
    stop_id           TEXT PRIMARY KEY REFERENCES gtfs_bus.stops(stop_id),
    stop_code         TEXT NOT NULL,
    -- stable id of the merged stop LOCATION; join key for every count
    physical_stop_id  TEXT NOT NULL,
    -- cluster centroid, WGS84 (served); computed in EPSG:32643
    centroid_lon      DOUBLE PRECISION NOT NULL,
    centroid_lat      DOUBLE PRECISION NOT NULL,
    -- distinct stop_codes (poles) merged into this location
    member_count      INTEGER NOT NULL,
    -- max pairwise distance within the cluster, metres. Bounded by
    -- threshold_m by construction -- a QA handle for the methodology drawer.
    diameter_m        NUMERIC NOT NULL,
    -- provenance of the merge, so the number can defend itself
    method            TEXT NOT NULL DEFAULT 'complete_linkage',
    threshold_m       NUMERIC NOT NULL DEFAULT 40,
    crs               TEXT NOT NULL DEFAULT 'EPSG:32643'
);
CREATE INDEX IF NOT EXISTS idx_stop_clusters_physical ON derived.stop_clusters (physical_stop_id);
CREATE INDEX IF NOT EXISTS idx_stop_clusters_code     ON derived.stop_clusters (stop_code);

-- ============================================================================
-- NEW — derived.route_stops / derived.stop_hourly_frequency
-- Added during the GCP -> Supabase migration to replace two agent tools'
-- live dependency on raw gtfs_bus.stop_times (3.7M rows, excluded above).
-- Populated by pipeline/precompute_route_aggregates.py from the local
-- data/processed/bus/{stop_times,trips}.csv files -- no GCP access needed.
-- ============================================================================

-- Ordered stop list per route (one representative trip's sequence per
-- route_id -- replaces get_route_coverage()'s live trips+stop_times join).
CREATE TABLE IF NOT EXISTS derived.route_stops (
    route_id      TEXT NOT NULL,
    feed          TEXT NOT NULL,
    stop_sequence INTEGER NOT NULL,
    stop_id       TEXT NOT NULL,
    PRIMARY KEY (route_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_route_stops_route ON derived.route_stops (route_id);

-- Per-stop, per-hour-of-day scheduled trip counts (replaces
-- get_frequency_at_stop()'s live per-second-window count against raw
-- stop_times). hour_of_day extends past 23 for GTFS's >24:00:00 overnight
-- times (e.g. 25 = 1am service coded as next-day 25:00). Precision is
-- coarser than the original (hourly buckets vs exact-second windows) --
-- documented tradeoff, not a bug.
CREATE TABLE IF NOT EXISTS derived.stop_hourly_frequency (
    stop_id     TEXT NOT NULL,
    feed        TEXT NOT NULL,
    hour_of_day SMALLINT NOT NULL,
    trip_count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (stop_id, hour_of_day)
);
CREATE INDEX IF NOT EXISTS idx_stop_hourly_freq_stop ON derived.stop_hourly_frequency (stop_id);

-- ============================================================================
-- embeddings.stop_embeddings — optional pgvector table for
-- semantic_stop_search()'s cosine-similarity path. Populated by
-- pipeline/embed.py. If absent/empty, the tool falls back to pg_trgm
-- trigram similarity automatically -- this table is not required for the
-- app to function.
--
-- Vector dimension: gemini-embedding-001 (used by embed.py) defaults to a
-- 3072-dim output with no output_dimensionality override set in the code.
-- NOT independently verified against a live embedding response this
-- session -- if pgvector index creation fails or embed.py errors on insert,
-- check the actual returned vector length first (pgvector HNSW/IVFFlat
-- indexes cap out around 2000 dims; plain unindexed vector columns support
-- more but similarity search will be a full scan).
-- ============================================================================

CREATE TABLE IF NOT EXISTS embeddings.stop_embeddings (
    stop_id   TEXT PRIMARY KEY,
    stop_name TEXT,
    feed      TEXT,
    context   TEXT,
    embedding VECTOR(3072)   -- verify dimension against a real embed_content() response before first load
);

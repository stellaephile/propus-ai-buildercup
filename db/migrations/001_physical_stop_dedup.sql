-- 001_physical_stop_dedup.sql
--
-- WHY THIS FILE EXISTS. db/schema.sql uses `CREATE TABLE IF NOT EXISTS`
-- everywhere, which is safe for a fresh database but a no-op against a table
-- that already exists — Postgres will not retrofit new columns onto an
-- existing table just because schema.sql grew some. Commit f082234 ("de-
-- duplicate bus stop counts via physical-stop clustering") added stop_code
-- to two GTFS tables, three new derived.ward_metrics columns, and the whole
-- new derived.stop_clusters table — but re-running schema.sql against an
-- already-provisioned Supabase instance silently did nothing, because every
-- statement in it hit an existing table and was skipped. The result in
-- production: `psycopg2.errors.UndefinedColumn: column
-- wm.physical_stop_density_per_km2 does not exist` on every density/worst-
-- wards query.
--
-- This migration is the explicit ALTER TABLE schema.sql couldn't express.
-- Every statement is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
-- so it's safe to run against a database that already has some or none of
-- this — including a fresh one that already matches current schema.sql.
--
-- Run once against the live database, as the owner/migration role (not the
-- read-only propus_agent_ro role — it can't ALTER TABLE):
--
--   psql "$DATABASE_URL" -f db/migrations/001_physical_stop_dedup.sql
--
-- Schema alone is not the full fix — see "After this migration" at the
-- bottom: the new columns exist but are NULL until the pipeline is re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. stop_code on both GTFS stop tables — the physical-boarding-point key.
--    10,559 stop_id rows collapse to 6,880 stop_codes; see derived.stop_clusters
--    below for why stop_id alone triple-counts.
-- ---------------------------------------------------------------------------

ALTER TABLE gtfs_bus.stops   ADD COLUMN IF NOT EXISTS stop_code TEXT;
ALTER TABLE gtfs_metro.stops ADD COLUMN IF NOT EXISTS stop_code TEXT;

CREATE INDEX IF NOT EXISTS idx_gtfs_bus_stops_code ON gtfs_bus.stops (stop_code);

-- ---------------------------------------------------------------------------
-- 2. derived.ward_metrics — the three columns the live queries were missing.
--    bus_stop_count and stop_density_per_km2 (the pre-existing, now-LEGACY
--    columns built on raw stop_id) are untouched; these are their de-
--    duplicated replacements.
-- ---------------------------------------------------------------------------

ALTER TABLE derived.ward_metrics
    ADD COLUMN IF NOT EXISTS bus_boarding_point_count     INTEGER,
    ADD COLUMN IF NOT EXISTS bus_physical_stop_count      INTEGER,
    ADD COLUMN IF NOT EXISTS physical_stop_density_per_km2 NUMERIC;

-- ---------------------------------------------------------------------------
-- 3. derived.stop_clusters — brand new table, the physical-stop crosswalk.
--    Genuinely new (not a retrofit), so CREATE TABLE IF NOT EXISTS is
--    correct here — kept identical to db/schema.sql so the two never drift.
--    Full rationale (complete-linkage clustering, 40m threshold, why not
--    ST_ClusterDBSCAN) lives as comments in db/schema.sql; not repeated here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS derived.stop_clusters (
    stop_id           TEXT PRIMARY KEY REFERENCES gtfs_bus.stops(stop_id),
    stop_code         TEXT NOT NULL,
    physical_stop_id  TEXT NOT NULL,
    centroid_lon      DOUBLE PRECISION NOT NULL,
    centroid_lat      DOUBLE PRECISION NOT NULL,
    member_count      INTEGER NOT NULL,
    diameter_m        NUMERIC NOT NULL,
    method            TEXT NOT NULL DEFAULT 'complete_linkage',
    threshold_m       NUMERIC NOT NULL DEFAULT 40,
    crs               TEXT NOT NULL DEFAULT 'EPSG:32643'
);
CREATE INDEX IF NOT EXISTS idx_stop_clusters_physical ON derived.stop_clusters (physical_stop_id);
CREATE INDEX IF NOT EXISTS idx_stop_clusters_code     ON derived.stop_clusters (stop_code);

COMMIT;

-- ---------------------------------------------------------------------------
-- After this migration: the UndefinedColumn error is gone, but the three new
-- ward_metrics columns and derived.stop_clusters are empty (NULL / 0 rows)
-- until the pipeline actually computes and loads them. Re-run, against this
-- same DATABASE_URL, in this order:
--
--   python pipeline/cluster_stops.py     # builds derived.stop_clusters
--   python pipeline/compute.py           # recomputes ward_metrics stop counts
--                                         #   + physical_stop_density_per_km2
--   python pipeline/rs_worldpop.py       # updates stops_per_10k to use the
--                                         #   physical-stop count
--
-- data/processed/bus/stops.csv (cluster_stops.py's input) is already
-- committed/present locally — no upstream re-fetch needed, just point these
-- three scripts at production DATABASE_URL and run them once.
-- ---------------------------------------------------------------------------

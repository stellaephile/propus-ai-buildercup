-- ============================================================================
-- Propus — read-only, table-allowlisted DB role for the agent (CLAUDE.md §5.3
-- / TASKS.md B2.5). The agent connects as this role, never as the
-- postgres/service-role owner, so a prompt-injected or buggy tool call
-- cannot write data or run an unbounded query.
--
-- Run once against Supabase (as the postgres/owner role). Idempotent.
-- ============================================================================

-- psql does not substitute :'vars' inside dollar-quoted ($$) blocks, so the
-- create-or-alter branch is built as top-level SQL and run via \gexec
-- instead of a DO block.
SELECT format(
    CASE WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = 'propus_agent_ro')
         THEN 'ALTER ROLE propus_agent_ro PASSWORD %L'
         ELSE 'CREATE ROLE propus_agent_ro LOGIN PASSWORD %L'
    END,
    :'agent_ro_password'
) AS ddl \gexec

-- Kill any single statement that runs past 5s — a deliberately slow or
-- malformed query (e.g. a missing spatial index, a Cartesian join) can
-- never hang the demo.
ALTER ROLE propus_agent_ro SET statement_timeout = '5s';

-- CREATE ROLE ... LOGIN PASSWORD above grants no SUPERUSER/CREATEDB/
-- CREATEROLE/REPLICATION attribute, so the role is already least-privilege
-- by default — no further ALTER needed (and Supabase's managed "postgres"
-- role isn't a true superuser, so it can't grant/revoke those attributes
-- explicitly anyway).

GRANT USAGE ON SCHEMA public, gtfs_bus, gtfs_metro, derived, embeddings, extensions TO propus_agent_ro;

-- PostGIS lives in Supabase's `extensions` schema; put it in this role's
-- default search_path so ad-hoc ST_* calls elsewhere (outside the fn_*
-- functions, which pin their own search_path) resolve without schema-
-- qualifying every call.
ALTER ROLE propus_agent_ro SET search_path = public, extensions;

-- Table allowlist — only what the agent's tools actually read. New tables
-- (e.g. a future gtfs_bus.stop_times) are NOT visible until explicitly
-- granted here, even though the role has schema USAGE.
GRANT SELECT ON
    public.wards,
    gtfs_bus.stops, gtfs_bus.routes, gtfs_bus.trips, gtfs_bus.shapes, gtfs_bus.calendar,
    gtfs_metro.stops, gtfs_metro.routes, gtfs_metro.trips, gtfs_metro.stop_times,
    gtfs_metro.shapes, gtfs_metro.calendar,
    derived.ward_metrics, derived.route_stops, derived.stop_hourly_frequency,
    derived.route_geometries,
    derived.transit_points, derived.pop_cells, derived.stop_heat,
    embeddings.stop_embeddings
TO propus_agent_ro;

-- The deterministic geo layer (B2.5) — the agent calls these, never
-- free-written spatial SQL, for catchment/worst-wards/density/choropleth.
--
-- fn_ward_density_rank was migrated from a 1-arg to a 2-arg signature in
-- db/functions.sql (see its DROP FUNCTION IF EXISTS(INTEGER)) but this grant
-- was never updated to match — the read-only role had EXECUTE on a signature
-- that no longer exists, so get_ward_density_ranking() silently fell back to
-- its inline-SQL pre-migration path on every call instead of using the
-- function (agent.py's fallback masked this rather than erroring). Same gap
-- for fn_reverse_geocode, which was never granted at all. Fixed here, plus
-- the new fn_pop_walk_access.
GRANT EXECUTE ON FUNCTION
    fn_worst_wards(TEXT, INTEGER),
    fn_ward_density_rank(TEXT, INTEGER),
    fn_catchment(NUMERIC, NUMERIC, INTEGER),
    fn_ward_choropleth(),
    fn_reverse_geocode(NUMERIC, NUMERIC, INTEGER),
    fn_pop_walk_access(INTEGER, INTEGER),
    fn_coverage_gap(INTEGER, INTEGER, TEXT, INTEGER),
    fn_stop_heat_exposure(NUMERIC, INTEGER, TEXT, INTEGER)
TO propus_agent_ro;

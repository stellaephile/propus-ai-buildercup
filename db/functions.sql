-- ============================================================================
-- Propus — deterministic geo layer (CLAUDE.md §5 / TASKS.md B2.5)
--
-- Catchment, choropleth, density, and scenario math live here as parametrized
-- PostGIS SQL functions. The agent CALLS these; it never free-writes spatial
-- SQL for these operations. All are STABLE (read-only) and take simple
-- scalar args so they're safe to expose to an LLM-driven tool layer.
--
-- Geometry payload budget (CLAUDE.md §5.4): geometries returned here are
-- ST_SimplifyPreserveTopology'd and coordinate-rounded to 5 decimals
-- (~1.1m at Delhi's latitude) before being turned into GeoJSON, so the
-- Python layer doesn't need to reprocess geometry — just json.loads() it.
--
-- CRS: all inputs/outputs are WGS84 (EPSG:4326) lon/lat. Distance and area
-- math is done via ::geography casts (equivalent to projecting into a local
-- azimuthal metric system) or explicit ST_Transform(..., 32643) for UTM 43N
-- where an area figure is reported, per CLAUDE.md §3.5.
--
-- search_path: Supabase installs PostGIS into the `extensions` schema, not
-- `public`. Every function below pins search_path explicitly so it resolves
-- ST_* regardless of the calling role's own search_path (the agent's
-- read-only role has no reason to carry `extensions` in its default path).
-- ============================================================================

-- Simplification tolerance in degrees (~10m at Delhi's latitude, coarse
-- enough to shrink ward polygons for map payload, fine enough that no
-- ward becomes topologically invalid or visibly distorted at city zoom).
-- Kept as a SQL constant (not a function arg) so callers can't request an
-- arbitrarily large tolerance that would visibly distort geometry.

CREATE OR REPLACE FUNCTION _simplify_round(geom GEOMETRY)
RETURNS GEOMETRY
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
    SELECT ST_SnapToGrid(
        ST_SimplifyPreserveTopology(geom, 0.0001),
        0.00001
    );
$$;


-- ----------------------------------------------------------------------------
-- fn_worst_wards — ranks wards by an allowlisted metric ascending (worst
-- first). Replaces find_underserved_areas()'s inline SQL in agent.py.
-- ----------------------------------------------------------------------------
-- Migration note: bus_physical_stop_count was added to the return type, so the
-- old signature must be dropped before the redefinition (CREATE OR REPLACE
-- cannot change a function's RETURNS TABLE).
DROP FUNCTION IF EXISTS fn_worst_wards(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION fn_worst_wards(
    p_metric TEXT DEFAULT 'transit_score',
    p_limit  INTEGER DEFAULT 15
)
RETURNS TABLE (
    ward_id TEXT,
    ward_name TEXT,
    -- raw stop_id count; ~2.6x inflated, kept for continuity only
    bus_stop_count INTEGER,
    -- distinct clustered stop LOCATIONS (Estimated) — the honest count
    bus_physical_stop_count INTEGER,
    metro_stop_count INTEGER,
    peak_freq_mean NUMERIC,
    has_metro_within_1k BOOLEAN,
    transit_score NUMERIC,
    pop_total INTEGER,
    stops_per_10k NUMERIC,
    multimodal_gap_count INTEGER,
    geometry JSON
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
    IF p_metric NOT IN ('transit_score', 'stops_per_10k', 'bus_stop_count',
                        'bus_physical_stop_count', 'physical_stop_density_per_km2') THEN
        RAISE EXCEPTION 'p_metric must be one of transit_score, stops_per_10k, bus_stop_count, bus_physical_stop_count, physical_stop_density_per_km2';
    END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 100);

    RETURN QUERY EXECUTE format($f$
        SELECT wm.ward_id, wm.ward_name, wm.bus_stop_count,
               wm.bus_physical_stop_count, wm.metro_stop_count,
               ROUND(wm.peak_freq_mean::numeric, 2), wm.has_metro_within_1k,
               ROUND(wm.transit_score::numeric, 4), wm.pop_total,
               ROUND(wm.stops_per_10k::numeric, 4), wm.multimodal_gap_count,
               ST_AsGeoJSON(_simplify_round(w.geometry), 5)::json
        FROM derived.ward_metrics wm
        JOIN public.wards w ON w.ward_id = wm.ward_id
        ORDER BY wm.%I ASC NULLS FIRST
        LIMIT %L
    $f$, p_metric, p_limit);
END;
$$;


-- ----------------------------------------------------------------------------
-- fn_ward_density_rank — top-N wards by an allowlisted metric, HIGHEST first
-- (query #4 bar chart; also answers "best transit access" with
-- p_metric='transit_score'). Returns simplified geometry so the ranked wards
-- can be highlighted on the map, mirroring fn_worst_wards.
-- Migration note: drops the old single-arg overload.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_ward_density_rank(INTEGER);
DROP FUNCTION IF EXISTS fn_ward_density_rank(TEXT, INTEGER);

-- Default metric is bus_physical_stop_count, NOT bus_stop_count. Query #4
-- ("rank the top 10 wards by bus stop density") is a ranking, and the raw
-- stop_id inflation is not uniform across wards (1.0x-11.0x, sigma 0.96), so it
-- reorders the leaderboard rather than scaling it: 4 of the top 10 change.
CREATE OR REPLACE FUNCTION fn_ward_density_rank(
    p_metric TEXT DEFAULT 'bus_physical_stop_count',
    p_limit  INTEGER DEFAULT 10
)
RETURNS TABLE (
    ward_id TEXT,
    ward_name TEXT,
    bus_stop_count INTEGER,
    bus_physical_stop_count INTEGER,
    physical_stop_density_per_km2 NUMERIC,
    transit_score NUMERIC,
    pop_total INTEGER,
    stops_per_10k NUMERIC,
    geometry JSON
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
BEGIN
    IF p_metric NOT IN ('bus_stop_count', 'stops_per_10k', 'transit_score',
                        'bus_physical_stop_count', 'physical_stop_density_per_km2') THEN
        RAISE EXCEPTION 'p_metric must be one of bus_stop_count, stops_per_10k, transit_score, bus_physical_stop_count, physical_stop_density_per_km2';
    END IF;
    p_limit := LEAST(GREATEST(p_limit, 1), 50);

    RETURN QUERY EXECUTE format($f$
        SELECT wm.ward_id, wm.ward_name, wm.bus_stop_count,
               wm.bus_physical_stop_count,
               ROUND(wm.physical_stop_density_per_km2::numeric, 4),
               ROUND(wm.transit_score::numeric, 4), wm.pop_total,
               ROUND(wm.stops_per_10k::numeric, 4),
               ST_AsGeoJSON(_simplify_round(w.geometry), 5)::json
        FROM derived.ward_metrics wm
        JOIN public.wards w ON w.ward_id = wm.ward_id
        ORDER BY wm.%I DESC NULLS LAST
        LIMIT %L
    $f$, p_metric, p_limit);
END;
$$;


-- ----------------------------------------------------------------------------
-- fn_ward_choropleth — all 290 wards with metrics, for the default/worst-
-- wards choropleth. Replaces get_urban_stress_map()'s inline SQL, which
-- previously returned full-precision geometry (the payload-budget
-- violation CLAUDE.md §5.4 flags).
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_ward_choropleth();

CREATE OR REPLACE FUNCTION fn_ward_choropleth()
RETURNS TABLE (
    ward_id TEXT,
    ward_name TEXT,
    transit_score NUMERIC,
    bus_stop_count INTEGER,
    bus_physical_stop_count INTEGER,
    physical_stop_density_per_km2 NUMERIC,
    pop_total INTEGER,
    stops_per_10k NUMERIC,
    ndvi_mean NUMERIC,
    ndbi_mean NUMERIC,
    urban_stress_index NUMERIC,
    has_metro_within_1k BOOLEAN,
    geometry JSON
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
    SELECT w.ward_id, w.ward_name,
           ROUND(wm.transit_score::numeric, 4), wm.bus_stop_count,
           wm.bus_physical_stop_count,
           ROUND(wm.physical_stop_density_per_km2::numeric, 4),
           wm.pop_total, ROUND(wm.stops_per_10k::numeric, 4),
           ROUND(wm.ndvi_mean::numeric, 4), ROUND(wm.ndbi_mean::numeric, 4),
           ROUND(wm.urban_stress_index::numeric, 4), wm.has_metro_within_1k,
           ST_AsGeoJSON(_simplify_round(w.geometry), 5)::json
    FROM public.wards w
    JOIN derived.ward_metrics wm ON wm.ward_id = w.ward_id
    ORDER BY w.ward_name;
$$;


-- ----------------------------------------------------------------------------
-- fn_catchment — buffer catchment around a point (metro station or
-- candidate scenario point). Used by query #3 (Kashmere Gate 500m) and
-- query #5 (scenario slider — same math, arbitrary point + radius).
--
-- Population covered is a real WorldPop-derived areal-weighted estimate:
-- for each ward that intersects the buffer, take pop_total * (intersection
-- area / ward area), assuming uniform population density within a ward
-- (a documented approximation — WorldPop's ward-level zonal sum has no
-- finer-grained shape to weight by here). Area math is done in EPSG:32643
-- (UTM 43N) per CLAUDE.md §3.5.
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_catchment(NUMERIC, NUMERIC, INTEGER);

CREATE OR REPLACE FUNCTION fn_catchment(
    p_lon NUMERIC,
    p_lat NUMERIC,
    p_radius_m INTEGER DEFAULT 500
)
RETURNS TABLE (
    buffer_geojson JSON,
    -- distinct clustered stop LOCATIONS in the catchment (Estimated). This is
    -- the headline figure: two poles either side of a road are ONE stop you can
    -- walk to, and at a 500 m radius their catchments overlap 97.4%.
    bus_stops_in_catchment INTEGER,
    -- distinct physical poles (Observed) — boardable positions, both directions
    bus_boarding_points_in_catchment INTEGER,
    metro_stops_in_catchment INTEGER,
    estimated_population_covered INTEGER,
    intersecting_ward_count INTEGER
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_radius INTEGER := LEAST(GREATEST(p_radius_m, 50), 5000);
    v_center GEOGRAPHY := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography;
    v_buffer GEOMETRY := ST_Buffer(v_center, v_radius)::geometry;
BEGIN
    RETURN QUERY
    WITH ward_overlap AS (
        SELECT
            w.ward_id,
            wm.pop_total,
            -- areal-weighted population share covered by the buffer
            CASE WHEN wm.pop_total IS NULL THEN 0 ELSE
                wm.pop_total * (
                    ST_Area(ST_Transform(ST_Intersection(w.geometry, v_buffer), 32643))
                    / NULLIF(ST_Area(ST_Transform(w.geometry, 32643)), 0)
                )
            END AS pop_share
        FROM public.wards w
        LEFT JOIN derived.ward_metrics wm ON wm.ward_id = w.ward_id
        WHERE ST_Intersects(w.geometry, v_buffer)
    )
    SELECT
        ST_AsGeoJSON(_simplify_round(v_buffer), 5)::json,
        -- COALESCE to stop_id means an unbuilt/partial crosswalk degrades to the
        -- old raw count rather than silently returning zero.
        (SELECT COUNT(DISTINCT COALESCE(sc.physical_stop_id, s.stop_id))::int
           FROM gtfs_bus.stops s
           LEFT JOIN derived.stop_clusters sc ON sc.stop_id = s.stop_id
          WHERE ST_DWithin(s.geom::geography, v_center, v_radius)),
        (SELECT COUNT(DISTINCT COALESCE(s.stop_code, s.stop_id))::int
           FROM gtfs_bus.stops s
          WHERE ST_DWithin(s.geom::geography, v_center, v_radius)),
        (SELECT COUNT(*)::int FROM gtfs_metro.stops WHERE ST_DWithin(geom::geography, v_center, v_radius)),
        COALESCE(ROUND(SUM(pop_share))::int, 0),
        COUNT(*)::int
    FROM ward_overlap;
END;
$$;


-- ----------------------------------------------------------------------------
-- fn_pop_walk_access — % of population within walking distance of transit,
-- per ward and city-wide (Python sums the per-ward rows for the city total).
-- "Walking distance" is two independently-radiused buffers: p_bus_radius_m
-- around bus stops, p_metro_radius_m around metro stations (defaults 500m /
-- 800m — standard walk-access benchmarks, overridable per query).
--
-- Coverage geometry = ONE citywide ST_Union of every bus-stop buffer and
-- every metro-stop buffer, computed once (not once per ward — an earlier
-- version did that and timed out on the real ~10.8k-stop dataset: 290
-- separate unions of overlapping, geography-buffered circles). Each ward's
-- pop_covered is then just an intersection + area ratio against that single
-- precomputed geometry. Population covered reuses fn_catchment's areal-
-- weighted approximation: ward.pop_total × (intersection area / ward area),
-- assuming uniform density within a ward — same documented limitation.
--
-- Buffering happens in EPSG:32643 (planar, metres) rather than ::geography —
-- geography buffering is materially more expensive for GEOS at this stop
-- volume, and CLAUDE.md §3.5 already prescribes 32643 for area/distance math.
-- quad_segs is lowered to 4 (16-gon circles) since this coverage geometry is
-- purely internal (never returned to the caller) — the areal-weighting is
-- already an approximation, so per-stop buffer smoothness doesn't matter.
-- The unioned coverage is simplified with a small (2m) tolerance before the
-- per-ward intersection pass to keep that pass cheap too.
--
-- coverage_geometry (the actual walkshed polygon, transformed back to WGS84)
-- is surfaced on the FIRST row only, NULL on the rest — it's identical for
-- every row (computed once, not per ward), so repeating it 290x would blow
-- the geometry payload budget for no reason. Callers wanting the buffer read
-- row[0]. This is what the map should render for this query — a per-ward
-- choropleth of pct_covered materially overstates coverage (a ward with one
-- corner inside the buffer still gets colored across its whole polygon).
-- ----------------------------------------------------------------------------
-- Migration note: an earlier version returned a narrower row type (no
-- coverage_geometry column) — DROP first since CREATE OR REPLACE can't
-- change a function's OUT-parameter row type in place.
DROP FUNCTION IF EXISTS fn_pop_walk_access(INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION fn_pop_walk_access(
    p_bus_radius_m   INTEGER DEFAULT 500,
    p_metro_radius_m INTEGER DEFAULT 800
)
RETURNS TABLE (
    ward_id TEXT,
    ward_name TEXT,
    pop_total INTEGER,
    pop_covered INTEGER,
    pct_covered NUMERIC,
    geometry JSON,
    coverage_geometry JSON
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_bus_r   INTEGER := LEAST(GREATEST(p_bus_radius_m, 50), 2000);
    v_metro_r INTEGER := LEAST(GREATEST(p_metro_radius_m, 50), 3000);
BEGIN
    RETURN QUERY
    WITH coverage AS (
        SELECT ST_SimplifyPreserveTopology(ST_Union(buf), 2) AS geom
        FROM (
            SELECT ST_Buffer(ST_Transform(b.geom, 32643), v_bus_r, 4) AS buf
            FROM gtfs_bus.stops b
            UNION ALL
            SELECT ST_Buffer(ST_Transform(m.geom, 32643), v_metro_r, 4)
            FROM gtfs_metro.stops m
        ) s
    ),
    ward_pop AS (
        SELECT
            w.ward_id, w.ward_name, wm.pop_total, w.geometry AS ward_geom, c.geom AS coverage_geom,
            CASE WHEN wm.pop_total IS NULL OR c.geom IS NULL THEN 0 ELSE
                LEAST(wm.pop_total, ROUND(wm.pop_total * (
                    ST_Area(ST_Intersection(ST_Transform(w.geometry, 32643), c.geom))
                    / NULLIF(ST_Area(ST_Transform(w.geometry, 32643)), 0)
                ))::int)
            END AS pop_covered
        FROM public.wards w
        LEFT JOIN derived.ward_metrics wm ON wm.ward_id = w.ward_id
        CROSS JOIN coverage c
    )
    SELECT
        wp.ward_id, wp.ward_name, wp.pop_total, wp.pop_covered,
        CASE WHEN wp.pop_total IS NULL OR wp.pop_total = 0 THEN NULL
             ELSE ROUND(100.0 * wp.pop_covered / wp.pop_total, 2) END,
        ST_AsGeoJSON(_simplify_round(wp.ward_geom), 5)::json,
        CASE WHEN ROW_NUMBER() OVER (ORDER BY wp.ward_name) = 1
             THEN ST_AsGeoJSON(_simplify_round(ST_Transform(wp.coverage_geom, 4326)), 5)::json
             ELSE NULL END
    FROM ward_pop wp
    ORDER BY wp.ward_name;
END;
$$;


-- ----------------------------------------------------------------------------
-- fn_reverse_geocode — resolve a point to the Delhi ward that contains it.
-- Exact ST_Within match first; if the point falls outside every ward
-- polygon (GPS noise, a point just past a boundary, water/unmapped strip),
-- fall back to the nearest ward within p_buffer_m and report match_type +
-- distance so the caller can judge confidence. Returns zero rows if nothing
-- is within the buffer at all.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_reverse_geocode(
    p_lon NUMERIC,
    p_lat NUMERIC,
    p_buffer_m INTEGER DEFAULT 200
)
RETURNS TABLE (
    ward_id TEXT,
    ward_name TEXT,
    match_type TEXT,
    distance_m INTEGER
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_buffer INTEGER := LEAST(GREATEST(p_buffer_m, 0), 2000);
    v_point GEOMETRY := ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326);
    v_point_geog GEOGRAPHY := v_point::geography;
BEGIN
    RETURN QUERY
    SELECT w.ward_id, w.ward_name, 'exact'::text, 0
    FROM public.wards w
    WHERE ST_Within(v_point, w.geometry)
    LIMIT 1;

    IF FOUND THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT w.ward_id, w.ward_name, 'buffered'::text,
           ROUND(ST_Distance(w.geometry::geography, v_point_geog))::int
    FROM public.wards w
    WHERE ST_DWithin(w.geometry::geography, v_point_geog, v_buffer)
    ORDER BY w.geometry::geography <-> v_point_geog
    LIMIT 1;
END;
$$;


-- ============================================================================
-- Sustainability module (AI Builder Cup 2026) — docs/DECISIONS.md D6–D16.
-- Both read only precomputed tables (derived.pop_cells, derived.transit_points,
-- derived.stop_heat); distances were computed in EPSG:32643 at load time.
-- Each returns one JSON object so a city summary is present even when the
-- ranked list is empty.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- fn_coverage_gap — population farther than a walk radius from transit, plus
-- the largest unserved 1 km clusters. Straight-line distance, WorldPop 100 m
-- cell centres (Estimated). Radii default to 500 m bus / 800 m metro (D15).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_coverage_gap(
    p_bus_radius_m   INTEGER DEFAULT 500,
    p_metro_radius_m INTEGER DEFAULT 800,
    p_mode           TEXT    DEFAULT 'any',
    p_top_n          INTEGER DEFAULT 10
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_bus_r   INTEGER := LEAST(GREATEST(COALESCE(p_bus_radius_m, 500), 200), 1500);
    v_metro_r INTEGER := LEAST(GREATEST(COALESCE(p_metro_radius_m, 800), 200), 1500);
    v_mode    TEXT    := lower(COALESCE(p_mode, 'any'));
    v_top_n   INTEGER := LEAST(GREATEST(COALESCE(p_top_n, 10), 1), 25);
    v_result  JSON;
BEGIN
    IF v_mode NOT IN ('any', 'bus', 'metro') THEN
        RAISE EXCEPTION 'mode must be any, bus or metro (got %)', p_mode;
    END IF;

    WITH cells AS (
        SELECT c.pop, c.geom_utm,
               CASE v_mode WHEN 'bus'   THEN c.dist_bus_m
                           WHEN 'metro' THEN c.dist_metro_m
                           ELSE c.dist_any_m END AS dist_m,
               CASE v_mode WHEN 'bus'   THEN c.dist_bus_m > v_bus_r
                           WHEN 'metro' THEN c.dist_metro_m > v_metro_r
                           ELSE c.dist_bus_m > v_bus_r AND c.dist_metro_m > v_metro_r
               END AS unserved
        FROM derived.pop_cells c
    ),
    totals AS (
        SELECT SUM(pop) AS total_pop, COALESCE(SUM(pop) FILTER (WHERE unserved), 0) AS unserved_pop
        FROM cells
    ),
    clusters AS (
        SELECT ROUND(SUM(pop))::int AS unserved_pop,
               COUNT(*)::int AS cells,
               ROUND(AVG(dist_m))::int AS avg_dist_m,
               ST_Transform(ST_Centroid(ST_Collect(geom_utm)), 4326) AS centre
        FROM cells
        WHERE unserved
        GROUP BY ST_SnapToGrid(geom_utm, 1000)
        ORDER BY SUM(pop) DESC
        LIMIT v_top_n
    )
    SELECT json_build_object(
        'mode', v_mode,
        'bus_radius_m', v_bus_r,
        'metro_radius_m', v_metro_r,
        'total_population', ROUND(t.total_pop)::bigint,
        'unserved_population', ROUND(t.unserved_pop)::bigint,
        'unserved_share_pct', ROUND((100 * t.unserved_pop / NULLIF(t.total_pop, 0))::numeric, 1),
        'clusters', COALESCE((
            SELECT json_agg(json_build_object(
                       'rank', rn, 'unserved_pop', unserved_pop, 'cells', cells,
                       'avg_dist_m', avg_dist_m,
                       'lon', ROUND(ST_X(centre)::numeric, 5),
                       'lat', ROUND(ST_Y(centre)::numeric, 5)) ORDER BY rn)
            FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY unserved_pop DESC) AS rn FROM clusters) r
        ), '[]'::json)
    )
    INTO v_result
    FROM totals t;

    RETURN v_result;
END;
$$;


-- ----------------------------------------------------------------------------
-- fn_stop_heat_exposure — transit points on the hottest surfaces, busiest
-- first. Landsat 8/9 summer median LST within 100 m (Estimated; land surface,
-- not air temperature). Default threshold = city mean + 1 SD of all transit
-- point LST (D16); pass p_threshold_c for a fixed °C cut (clamped 30–60).
-- trips_day = scheduled trips in the GTFS feed, not ridership.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_stop_heat_exposure(
    p_threshold_c NUMERIC DEFAULT NULL,
    p_min_trips   INTEGER DEFAULT 0,
    p_mode        TEXT    DEFAULT 'any',
    p_limit       INTEGER DEFAULT 20
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_catalog
AS $$
DECLARE
    v_mode      TEXT    := lower(COALESCE(p_mode, 'any'));
    v_min_trips INTEGER := GREATEST(COALESCE(p_min_trips, 0), 0);
    v_limit     INTEGER := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
    v_mean      NUMERIC;
    v_sd        NUMERIC;
    v_threshold NUMERIC;
    v_basis     TEXT;
    v_result    JSON;
BEGIN
    IF v_mode NOT IN ('any', 'bus', 'metro') THEN
        RAISE EXCEPTION 'mode must be any, bus or metro (got %)', p_mode;
    END IF;

    SELECT AVG(lst_c), STDDEV_SAMP(lst_c) INTO v_mean, v_sd
    FROM derived.stop_heat WHERE lst_c IS NOT NULL;

    IF p_threshold_c IS NULL THEN
        v_threshold := ROUND(v_mean + v_sd, 1);
        v_basis := 'city mean + 1 SD';
    ELSE
        v_threshold := LEAST(GREATEST(p_threshold_c, 30), 60);
        v_basis := 'fixed';
    END IF;

    WITH pts AS (
        SELECT t.point_id, t.name, t.mode, t.trips_day, t.geom, h.lst_c
        FROM derived.transit_points t
        JOIN derived.stop_heat h USING (point_id)
        WHERE h.lst_c IS NOT NULL AND (v_mode = 'any' OR t.mode = v_mode)
    ),
    hot AS (
        SELECT * FROM pts WHERE lst_c >= v_threshold AND trips_day >= v_min_trips
    )
    SELECT json_build_object(
        'mode', v_mode,
        'threshold_c', v_threshold,
        'threshold_basis', v_basis,
        'city_mean_lst_c', ROUND(v_mean, 1),
        'city_sd_lst_c', ROUND(v_sd, 1),
        'min_trips', v_min_trips,
        'stops_total', (SELECT COUNT(*) FROM pts),
        'stops_above_threshold', (SELECT COUNT(*) FROM hot),
        'trips_total', (SELECT SUM(trips_day) FROM pts),
        'trips_at_hot_stops', (SELECT COALESCE(SUM(trips_day), 0) FROM hot),
        'share_of_daily_trips_at_hot_stops_pct',
            (SELECT ROUND(100.0 * COALESCE(SUM(trips_day) FILTER (WHERE lst_c >= v_threshold
                                             AND trips_day >= v_min_trips), 0)
                          / NULLIF(SUM(trips_day), 0), 1) FROM pts),
        'stops', COALESCE((
            SELECT json_agg(json_build_object(
                       'point_id', point_id, 'name', name, 'mode', mode,
                       'lst_c', ROUND(lst_c::numeric, 1), 'trips_day', trips_day,
                       'lon', ROUND(ST_X(geom)::numeric, 5), 'lat', ROUND(ST_Y(geom)::numeric, 5)))
            FROM (SELECT * FROM hot ORDER BY trips_day DESC, lst_c DESC LIMIT v_limit) h
        ), '[]'::json)
    )
    INTO v_result;

    RETURN v_result;
END;
$$;

"""
apps/api/formatters.py
-----------------------
Maps raw agent tool outputs (plain dicts from apps/api/agent.py's tools) into
typed PropusResult objects (CLAUDE.md §6). This is the layer that lets the
map stay "dumb" — it only ever draws GeoJSON + a style spec the result gives
it, never raw SQL rows.

Keyed by tool name so the SSE endpoint can dispatch on which ADK tool call
just resolved. Each formatter returns a list[PropusResult] (a single tool
call can produce more than one result card, e.g. worst-wards → table + map
+ stat cards, matching CLAUDE.md §7's headline query #1).
"""

from __future__ import annotations

from typing import Any, Callable

try:
    from .schemas import (
        BarChartResult,
        BarSeriesPoint,
        ComparisonMetric,
        ComparisonResult,
        DataTableResult,
        Entity,
        MapLayerResult,
        MapStyleSpec,
        Methodology,
        PropusResult,
        ScatterChartResult,
        ScatterPoint,
        StatCard,
        StatCardsResult,
    )
except ImportError:
    from schemas import (
        BarChartResult,
        BarSeriesPoint,
        ComparisonMetric,
        ComparisonResult,
        DataTableResult,
        Entity,
        MapLayerResult,
        MapStyleSpec,
        Methodology,
        PropusResult,
        ScatterChartResult,
        ScatterPoint,
        StatCard,
        StatCardsResult,
    )

DELHI_CENTER = (77.2090, 28.6139)

EMPTY_FC: dict = {"type": "FeatureCollection", "features": []}


def _resolve_geometry(ref: str | None):
    """Fetch geometry a tool stashed out of the LLM's sight (agent.py
    side-channel). None if the ref is missing or expired — the caller
    renders an honest empty collection, never invented geometry."""
    try:
        from .agent import get_stashed_geometry
    except ImportError:
        from agent import get_stashed_geometry
    return get_stashed_geometry(ref)


def _wards_feature_collection(wards: list[dict]) -> dict:
    features = []
    for w in wards:
        geom = w.get("geometry")
        if geom is None:
            continue
        props = {k: v for k, v in w.items() if k != "geometry"}
        features.append({"type": "Feature", "geometry": geom, "properties": props})
    return {"type": "FeatureCollection", "features": features}


# ---------------------------------------------------------------------------
# find_underserved_areas — query #1: worst transit access
# ---------------------------------------------------------------------------

def format_find_underserved_areas(response: dict, args: dict) -> list[PropusResult]:
    wards = response.get("wards", [])
    if not wards:
        return [StatCardsResult(cards=[
            StatCard(label="Wards found", value="0", evidence="Calculated",
                      note="No wards matched — try a different metric or threshold."),
        ])]

    columns = ["Ward", "Bus Stops", "Metro Stops", "Peak Freq/hr", "Transit Score", "Population", "Stops/10k"]
    rows = [
        [
            w["ward_name"],
            w.get("bus_stop_count") or 0,
            w.get("metro_stop_count") or 0,
            w.get("peak_freq_mean") if w.get("peak_freq_mean") is not None else "N/A",
            w.get("transit_score") if w.get("transit_score") is not None else "N/A",
            w.get("pop_total") if w.get("pop_total") is not None else "N/A",
            w.get("stops_per_10k") if w.get("stops_per_10k") is not None else "N/A",
        ]
        for w in wards
    ]
    table = DataTableResult(
        columns=columns,
        rows=rows,
        evidence="Calculated",
        rowIds=[w["ward_id"] for w in wards],
        alertRows=list(range(len(wards))),  # every row here is by definition underserved
    )

    geoms = _resolve_geometry(response.get("geometry_ref")) or {}
    for w in wards:
        if "geometry" not in w:
            w["geometry"] = geoms.get(w["ward_id"])
    fc = _wards_feature_collection(wards)
    map_layer = MapLayerResult(
        layer="choropleth",
        geojson=fc,
        # "alert" is the real token name — the old "tertiaryContainer" key
        # silently fell back to primary blue, violating §3.4 (amber = underserved)
        style=MapStyleSpec(fillToken="alert", rampProperty=args.get("metric", "transit_score"), opacity=0.75),
        camera={"center": DELHI_CENTER, "zoom": 10},
        label="Worst transit access",
        legend=[{"label": "Underserved", "token": "alert"}],
    )

    scores = [w["transit_score"] for w in wards if w.get("transit_score") is not None]
    avg_score = round(sum(scores) / len(scores), 4) if scores else None
    stats = StatCardsResult(cards=[
        StatCard(label="Worst ward", value=wards[0]["ward_name"], evidence="Calculated"),
        StatCard(label="Wards shown", value=str(len(wards)), evidence="Observed"),
        StatCard(label="Avg transit score (shown)", value=str(avg_score) if avg_score is not None else "N/A",
                  evidence="Calculated", alert=True),
    ])

    results: list[PropusResult] = [table, map_layer, stats]

    # Two real numeric metrics per ward → scatter, decided by data shape alone
    # (never by the LLM). Wards missing either value are skipped, not padded
    # (§3.1); every ward in this response is by definition underserved, so
    # each point carries the amber alert flag — the same rule as alertRows.
    # Evidence "Estimated": the population axis is WorldPop-modelled.
    points = [
        ScatterPoint(
            label=w["ward_name"],
            x=float(w["pop_total"]),
            y=float(w["bus_stop_count"]),
            alert=True,
        )
        for w in wards
        if w.get("pop_total") is not None and w.get("bus_stop_count") is not None
    ]
    if len(points) >= 3:
        results.append(ScatterChartResult(
            x="pop_total",
            y="bus_stop_count",
            xLabel="Population (WorldPop 2020)",
            yLabel="Bus stops",
            points=points,
            evidence="Estimated",
            title="Population vs bus stops — underserved wards",
        ))

    return results


FIND_UNDERSERVED_METHODOLOGY = Methodology(
    formula="transit_score = 0.35·norm(stops/km²) + 0.25·norm(peak_freq) + 0.20·norm(routes) + 0.20·has_metro_within_1km",
    crs="EPSG:4326 (display); EPSG:32643 UTM 43N for any area/distance math upstream",
    sources=["OTD Delhi bus (DTC)", "DMRC metro", "OpenCity/DataMeet wards"],
    evidence="Calculated",
    caveats=[
        "urban_stress_index component (NDVI/NDBI) not yet loaded — ranking uses GTFS-only transit_score.",
        # Not an official/published formula — a prototype composite. The
        # coverage+frequency+route structure follows the general approach in
        # published transit-accessibility-index literature (e.g. Composite
        # Index of Public Transit Accessibility, sciencedirect.com/science/
        # article/pii/S1077291X22001965), but these specific weights are
        # team defaults, not calibrated to Delhi ridership/survey data.
        "Weights (0.35/0.25/0.20/0.20) are prototype defaults inspired by composite transit-accessibility-index literature, not an official or calibrated methodology.",
        # Verified 2026-09-07: a ward whose small polygon happens to contain
        # a bus depot/terminal or ISBT scores disproportionately well, since
        # that's literally where routes converge — Najafgarh and Peeragarhi
        # both rank in the top 20 by transit_score on exactly this basis
        # (real transit access at that node, not representative of the
        # broader — often peripheral — area the ward name colloquially means).
        "A ward containing a bus depot/terminal or ISBT scores disproportionately high (e.g. Najafgarh, Peeragarhi) — real access at that node, not necessarily representative of the wider area the name colloquially refers to.",
    ],
)


# ---------------------------------------------------------------------------
# get_ward_density_ranking — query #4: bar chart
# ---------------------------------------------------------------------------

_RANK_METRIC_LABELS = {
    "bus_stop_count": ("bus stop count", "Observed"),
    "transit_score": ("transit score", "Calculated"),
    "stops_per_10k": ("stops per 10k residents", "Calculated"),
}


def format_ward_density_ranking(response: dict, args: dict) -> list[PropusResult]:
    wards = response.get("wards", [])
    metric = response.get("metric", "bus_stop_count")
    label, evidence = _RANK_METRIC_LABELS.get(metric, (metric, "Calculated"))

    series = [BarSeriesPoint(label=w["ward_name"], value=w.get(metric) or 0) for w in wards]
    results: list[PropusResult] = [BarChartResult(
        x="ward_name", y=metric, series=series, evidence=evidence,
        title=f"Top wards by {label}",
    )]

    # Highlight the ranked wards on the map (same pattern as worst-wards).
    geoms = _resolve_geometry(response.get("geometry_ref")) or {}
    for w in wards:
        if "geometry" not in w:
            w["geometry"] = geoms.get(w["ward_id"])
    fc = _wards_feature_collection(wards)
    if fc.get("features"):
        results.append(MapLayerResult(
            layer="choropleth",
            geojson=fc,
            # madder, not primary: blue belongs to the metro identities now, and
            # madder is the design system's selection/highlight ink (§4)
            style=MapStyleSpec(fillToken="madder", rampProperty=metric, opacity=0.5),
            camera={"center": DELHI_CENTER, "zoom": 10},
            label=f"Top wards — {label}",
            legend=[{"label": f"Top {len(wards)} by {label}", "token": "madder"}],
        ))
    return results


# ---------------------------------------------------------------------------
# compare_transit_access — query #2: Dwarka vs Seemapuri
# ---------------------------------------------------------------------------

def _bbox_of_geojson(geoms: list[dict]) -> tuple[float, float, float, float] | None:
    """[west, south, east, north] over a list of GeoJSON geometries, by
    walking their coordinate arrays recursively — no shapely dependency."""
    xs: list[float] = []
    ys: list[float] = []

    def _walk(coords):
        if not coords:
            return
        if isinstance(coords[0], (int, float)):
            xs.append(coords[0])
            ys.append(coords[1])
        else:
            for c in coords:
                _walk(c)

    for g in geoms:
        if g and g.get("coordinates"):
            _walk(g["coordinates"])
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _entity_ward_features(entity: dict, fallback_name: str) -> list[dict]:
    """Normalise one side of a comparison into GeoJSON Features tagged with
    its ward name — single wards stash a raw geometry via geometry_ref;
    multi-ward aggregates (e.g. "DWARKA" matching many sub-wards) stash a
    whole FeatureCollection. Never invents geometry: a missing/expired stash
    just yields no features for that side, same as find_underserved_areas."""
    resolved = _resolve_geometry(entity.get("geometry_ref"))
    if not resolved:
        return []
    if resolved.get("type") == "FeatureCollection":
        return resolved.get("features", [])
    name = entity.get("ward_name", fallback_name)
    return [{"type": "Feature", "geometry": resolved, "properties": {"ward_name": name}}]


def format_compare_transit_access(response: dict, args: dict) -> list[PropusResult]:
    keys = list(response.keys())
    if len(keys) != 2:
        return [StatCardsResult(cards=[StatCard(label="Error", value="Comparison failed", evidence="Calculated", alert=True)])]

    name_a, name_b = keys
    a, b = response[name_a], response[name_b]
    if "error" in a or "error" in b:
        msg = a.get("error") or b.get("error")
        return [StatCardsResult(cards=[StatCard(label="Not found", value=msg, evidence="Calculated", alert=True)])]

    def _fmt(v):
        return "N/A" if v is None else str(v)

    metric_defs = [
        ("Bus stops", "bus_stop_count", "Observed"),
        ("Metro stops", "metro_stop_count", "Observed"),
        ("Peak freq/hr", "peak_freq_mean", "Calculated"),
        ("Transit score", "transit_score", "Calculated"),
        ("Population", "pop_total", "Estimated"),
        ("Stops/10k", "stops_per_10k", "Calculated"),
        ("Multimodal gap stops", "multimodal_gap_count", "Calculated"),
    ]
    metrics = [
        ComparisonMetric(label=label, a=_fmt(a.get(key)), b=_fmt(b.get(key)), evidence=ev)
        for label, key, ev in metric_defs
    ]

    disparity_pct = None
    ta, tb = a.get("transit_score"), b.get("transit_score")
    if ta and tb and tb > 0:
        disparity_pct = round(((ta - tb) / tb) * 100, 1)

    comparison = ComparisonResult(
        a=Entity(id=str(a.get("ward_id", name_a)), name=a.get("ward_name", name_a)),
        b=Entity(id=str(b.get("ward_id", name_b)), name=b.get("ward_name", name_b)),
        metrics=metrics,
        disparityPct=disparity_pct,
        disparityLabel=f"{name_a} vs {name_b} transit score disparity" if disparity_pct is not None else None,
    )
    results: list[PropusResult] = [comparison]

    # §7 query #2: comparison + map_layer(choropleth) highlighting both wards.
    features = _entity_ward_features(a, name_a) + _entity_ward_features(b, name_b)
    if features:
        bounds = _bbox_of_geojson([f["geometry"] for f in features])
        results.append(MapLayerResult(
            layer="choropleth",
            geojson={"type": "FeatureCollection", "features": features},
            style=MapStyleSpec(fillToken="primary", opacity=0.4),
            camera={"center": DELHI_CENTER, "zoom": 10, "bounds": bounds} if bounds else {"center": DELHI_CENTER, "zoom": 10},
            label=f"{comparison.a.name} vs {comparison.b.name}",
            # one swatch, not one per ward: both wards render with the same
            # fillToken (§ consistent with find_underserved_areas' uniform
            # highlight) — a legend row per ward would wrongly imply they're
            # two different colors on the map.
            legend=[{"label": f"{comparison.a.name} / {comparison.b.name}", "token": "primary"}],
        ))
    return results


# ---------------------------------------------------------------------------
# get_metro_catchment / simulate_new_stop_catchment — query #3 / #5
# ---------------------------------------------------------------------------

def format_catchment(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Not found", value=response["error"], evidence="Calculated", alert=True)])]

    center = None
    center_name = "Catchment centre"
    if "station" in response:
        center = (response["station"]["lon"], response["station"]["lat"])
        center_name = response["station"].get("name", "Station")
    elif "point" in response:
        center = (response["point"]["lon"], response["point"]["lat"])
        center_name = "Candidate station"

    r_inner = response.get("radius_m_inner", 500)
    r_outer = response.get("radius_m_outer", 800)

    # Outer ring first, inner ring second: MapLibre paints a fill layer's
    # features in source order, so the inner disc lands on top. Both use the
    # SAME fillToken/opacity below — the 0-500m disc is covered by both
    # polygons and so reads visibly denser than the 500-800m annulus (which
    # only the outer polygon covers) purely from the overlap, no per-feature
    # styling needed. Falls back to the single legacy buffer_ref/buffer_geojson
    # shape if a caller hasn't been updated to the dual-radius response yet.
    features: list[dict] = []
    outer_geom = response.get("buffer_geojson_outer") or _resolve_geometry(response.get("buffer_ref_outer"))
    inner_geom = response.get("buffer_geojson_inner") or _resolve_geometry(response.get("buffer_ref_inner"))
    if outer_geom:
        features.append({"type": "Feature", "geometry": outer_geom, "properties": {"radius_m": r_outer}})
    if inner_geom:
        features.append({"type": "Feature", "geometry": inner_geom, "properties": {"radius_m": r_inner}})
    if not features:
        if legacy := (response.get("buffer_geojson") or _resolve_geometry(response.get("buffer_ref"))):
            features.append({"type": "Feature", "geometry": legacy, "properties": {}})
    # the centre renders as the cursor point marker (bright ring + themed dot)
    if center:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": list(center)},
            "properties": {"name": center_name, "evidence": "Observed"},
        })
    fc = {"type": "FeatureCollection", "features": features} if features else EMPTY_FC

    map_layer = MapLayerResult(
        layer="buffer",
        geojson=fc,
        style=MapStyleSpec(fillToken="buffer", lineToken="buffer", opacity=0.35),
        camera={"center": list(center) if center else list(DELHI_CENTER), "zoom": 13.5},
        label=f"{r_inner}m + {r_outer}m combined catchment" if outer_geom and inner_geom
              else f"{response.get('radius_m', r_inner)}m catchment",
        legend=[{"label": f"{r_inner}m / {r_outer}m walk access", "token": "buffer"}] if outer_geom and inner_geom else None,
    )

    if outer_geom and inner_geom:
        stats = StatCardsResult(cards=[
            StatCard(label=f"Population covered ({r_inner}m)",
                      value=str(response.get("estimated_population_covered_inner", "N/A")),
                      unit="people", evidence="Calculated"),
            StatCard(label=f"Population covered ({r_outer}m)",
                      value=str(response.get("estimated_population_covered_outer", "N/A")),
                      unit="people", evidence="Calculated"),
            # bus_stops_in_catchment_* is the clustered PHYSICAL stop count
            # (derived.stop_clusters, 40m complete-linkage) -- a spatial
            # judgement, so Estimated, not Observed. bus_boarding_points_in_
            # catchment_* (distinct stop_code, Observed) is the lossless
            # alternative if a raw pole count is ever needed here instead.
            StatCard(label=f"Bus stop locations within {r_inner}m",
                      value=str(response.get("bus_stops_in_catchment_inner", 0)), evidence="Estimated"),
            StatCard(label=f"Metro stops within {r_outer}m",
                      value=str(response.get("metro_stops_in_catchment_outer", 0)), evidence="Observed"),
            StatCard(label=f"Wards intersected ({r_outer}m)",
                      value=str(response.get("intersecting_ward_count_outer", 0)), evidence="Observed"),
        ])
    else:
        # legacy single-radius shape
        stats = StatCardsResult(cards=[
            StatCard(label="Population covered", value=str(response.get("estimated_population_covered", "N/A")),
                      unit="people", evidence="Calculated"),
            # clustered PHYSICAL stop count (Estimated) -- see the dual-radius
            # card above for why this isn't Observed
            StatCard(label="Bus stop locations in catchment", value=str(response.get("bus_stops_in_catchment", 0)), evidence="Estimated"),
            StatCard(label="Metro stops in catchment", value=str(response.get("metro_stops_in_catchment", 0)), evidence="Observed"),
            StatCard(label="Wards intersected", value=str(response.get("intersecting_ward_count", 0)), evidence="Observed"),
        ])
    return [map_layer, stats]


CATCHMENT_METHODOLOGY = Methodology(
    formula="Buffer = ST_Buffer(point::geography, radius_m) at 500m and 800m; population = Σ ward.pop_total × (intersection_area / ward_area), areas in EPSG:32643",
    crs="EPSG:32643 (UTM 43N) for area math; EPSG:4326 for display",
    sources=["OTD Delhi bus (DTC)", "DMRC metro", "WorldPop 2020"],
    evidence="Calculated",
    caveats=[
        "Population assumes uniform density within each intersected ward (no finer-grained raster weighting applied).",
        "500m and 800m rings are computed independently, not subtracted — the 800m figures already include everything within 500m.",
    ],
)


# ---------------------------------------------------------------------------
# get_pop_walk_access — % of population within walking distance of transit
# ---------------------------------------------------------------------------

def format_pop_walk_access(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Error", value=str(response["error"]), evidence="Calculated", alert=True)])]

    bus_r = response.get("bus_radius_m", 500)
    metro_r = response.get("metro_radius_m", 800)
    pct = response.get("city_pct_covered")

    stats = StatCardsResult(cards=[
        StatCard(
            label="Population within walking access",
            value=f"{pct:.1f}" if pct is not None else "N/A",
            unit="%", evidence="Calculated",
            note=f"{bus_r}m walk to a bus stop or {metro_r}m to a metro station",
        ),
        StatCard(label="People covered", value=str(response.get("city_pop_covered", 0)), unit="people", evidence="Calculated"),
        StatCard(label="Delhi population (mapped wards)", value=str(response.get("city_pop_total", 0)), unit="people", evidence="Estimated"),
    ])

    # The map renders the actual walkshed (bus + metro buffers, unioned) —
    # NOT a per-ward choropleth. A choropleth of pct_covered overstates
    # coverage: a ward with one corner inside the buffer still renders
    # colored across its whole polygon, which reads as "this ward has
    # access" when most of it doesn't. The buffer is the honest picture.
    results: list[PropusResult] = [stats]
    buffer_geojson = _resolve_geometry(response.get("buffer_ref"))
    if buffer_geojson:
        fc = {
            "type": "FeatureCollection",
            "features": [{"type": "Feature", "geometry": buffer_geojson, "properties": {}}],
        }
        results.append(MapLayerResult(
            layer="buffer",
            geojson=fc,
            # bloomRing=False: this is a citywide MultiPolygon of hundreds of
            # disjoint walksheds, not one clean circle — the default dashed
            # bloom ring would draw around every separate blob and look like
            # noise (see MapStyleSpec.bloomRing in packages/contract).
            style=MapStyleSpec(fillToken="buffer", lineToken="buffer", opacity=0.35, bloomRing=False),
            camera={"center": DELHI_CENTER, "zoom": 10},
            label=f"{bus_r}m bus / {metro_r}m metro walk access",
            legend=[{"label": f"Within {bus_r}m of a bus stop or {metro_r}m of a metro station", "token": "buffer"}],
        ))
    return results


WALK_ACCESS_METHODOLOGY = Methodology(
    formula=(
        "coverage = ST_Union(bus-stop buffers @ bus_radius_m, metro-stop buffers @ metro_radius_m); "
        "pop_covered per ward = ward.pop_total × (area(ward ∩ coverage) / area(ward)), areas in EPSG:32643; "
        "city % = Σ pop_covered / Σ pop_total"
    ),
    crs="EPSG:32643 (UTM 43N) for area math; EPSG:4326 for display",
    sources=["OTD Delhi bus (DTC)", "DMRC metro", "WorldPop 2020", "OpenCity/DataMeet wards"],
    evidence="Calculated",
    caveats=[
        "Population assumes uniform density within each ward (no finer-grained raster weighting applied).",
        "Walking distance is straight-line buffer radius, not network/footpath distance.",
    ],
)


# ---------------------------------------------------------------------------
# coverage_gap — population beyond walking distance + largest unserved clusters
# ---------------------------------------------------------------------------

def format_coverage_gap(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Error", value=str(response["error"]), evidence="Calculated", alert=True)])]

    bus_r = response.get("bus_radius_m", 500)
    metro_r = response.get("metro_radius_m", 800)
    mode = response.get("mode", "any")
    reach = {
        "any": f"{bus_r}m of a bus stop and {metro_r}m of a metro station",
        "bus": f"{bus_r}m of a bus stop",
        "metro": f"{metro_r}m of a metro station",
    }[mode]
    pct = response.get("unserved_share_pct")
    clusters = response.get("top_gap_clusters") or []

    # WorldPop is modelled population, so every population figure here is
    # Estimated (docs/DECISIONS.md D9); the share is an underserved figure,
    # which is amber's legitimate use (§3.4).
    stats = StatCardsResult(cards=[
        StatCard(label="Population beyond walking distance", value=f"{pct:.1f}" if pct is not None else "N/A",
                 unit="%", evidence="Estimated", alert=True, note=f"Farther than {reach}"),
        StatCard(label="People beyond walking distance", value=str(response.get("unserved_population", 0)),
                 unit="people", evidence="Estimated"),
        StatCard(label="Delhi population (mapped wards)", value=str(response.get("total_population", 0)),
                 unit="people", evidence="Estimated"),
    ])
    results: list[PropusResult] = [stats]
    if not clusters:
        return results

    results.append(DataTableResult(
        columns=["Rank", "Unserved people", "Avg distance (m)", "Lon", "Lat"],
        rows=[[c["rank"], c["unserved_pop"], c["avg_dist_m"], c["lon"], c["lat"]] for c in clusters],
        evidence="Estimated",
    ))
    fc = {"type": "FeatureCollection", "features": [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
        "properties": {"name": f"Gap #{c['rank']}", "unserved_pop": c["unserved_pop"],
                       "avg_dist_m": c["avg_dist_m"], "evidence": "Estimated"},
    } for c in clusters]}
    results.append(MapLayerResult(
        layer="points",
        geojson=fc,
        style=MapStyleSpec(opacity=1),
        camera={"center": DELHI_CENTER, "zoom": 10},
        label=f"Largest coverage gaps (1 km clusters, {mode})",
    ))
    return results


COVERAGE_GAP_METHODOLOGY = Methodology(
    formula=(
        "unserved cell = nearest bus stop location > bus_radius_m AND nearest metro station > metro_radius_m "
        "(mode 'any'; one condition for 'bus'/'metro'); share = Σ pop(unserved) / Σ pop; "
        "clusters = unserved cells grouped on a 1 km grid, ranked by population"
    ),
    crs="EPSG:32643 (UTM 43N) for distances; EPSG:4326 for display",
    sources=["WorldPop 2020", "OTD Delhi bus (DTC)", "DMRC metro", "OpenCity/DataMeet wards"],
    evidence="Estimated",
    caveats=[
        "Straight-line distance from each 100 m cell centre, not network/footpath walking distance.",
        "Bus stops are de-duplicated physical stop locations (40 m clusters of boarding points).",
        "Defaults 500 m bus / 800 m metro follow India's National TOD Policy (500–800 m influence zone).",
    ],
)


# ---------------------------------------------------------------------------
# get_route_coverage — route line + stops, colored by DMRC line identity
# ---------------------------------------------------------------------------

# DMRC GTFS route_long_name prefix → color token (mirrors metroLineTokens in
# apps/web/lib/tokens.ts). The prefix is Observed feed data; the token maps it
# to the line's official identity color on the frontend.
METRO_LINE_TOKENS = {
    "AQUA": "metroAqua",
    "BLUE": "metroBlue",
    "GRAY": "metroGrey",
    "GREEN": "metroGreen",
    "MAGENTA": "metroMagenta",
    "ORANGE/AIRPORT": "metroOrange",
    "PINK": "metroPink",
    "RAPID": "metroRapid",
    "RED": "metroRed",
    "VIOLET": "metroViolet",
    "YELLOW": "metroYellow",
}


def format_route_coverage(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Not found", value=response["error"], evidence="Calculated", alert=True)])]

    route = response.get("route", {})
    long_name = route.get("route_long_name") or route.get("route_short_name") or "Route"
    is_metro = str(route.get("route_id", "")).startswith("metro_")
    line_name = long_name.split("_", 1)[0] if is_metro and "_" in long_name else None
    line_token = METRO_LINE_TOKENS.get(line_name) if line_name else None

    features: list[dict] = []
    shape = _resolve_geometry(response.get("shape_ref"))
    if shape:
        props: dict = {"name": long_name, "evidence": "Observed"}
        if line_name:
            props["metro_line"] = line_name
        features.append({"type": "Feature", "geometry": shape, "properties": props})

    stops = response.get("stops", [])
    lons: list[float] = []
    lats: list[float] = []
    for s in stops:
        if s.get("lon") is None or s.get("lat") is None:
            continue
        lons.append(s["lon"])
        lats.append(s["lat"])
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]},
            "properties": {"name": s.get("stop_name"), "stop_sequence": s.get("stop_sequence"),
                            "stop_id": s.get("stop_id"), "evidence": "Observed"},
        })
    if shape and shape.get("coordinates"):
        coords = shape["coordinates"]
        if shape.get("type") == "MultiLineString":
            coords = [pt for part in coords for pt in part]
        lons.extend(c[0] for c in coords)
        lats.extend(c[1] for c in coords)

    camera = None
    if lons and lats:
        camera = {"center": ((min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2),
                  "zoom": 11, "bounds": (min(lons), min(lats), max(lons), max(lats))}

    map_layer = MapLayerResult(
        layer="lines",
        geojson={"type": "FeatureCollection", "features": features},
        style=MapStyleSpec(
            lineToken=line_token or "primary",
            colorProperty="metro_line" if line_token else None,
            opacity=0.45,
        ),
        camera=camera,
        label=long_name,
        legend=[{"label": f"{line_name.title()} line" if line_name else long_name,
                  "token": line_token or "primary"}],
    )

    stats = StatCardsResult(cards=[
        StatCard(label="Route", value=long_name, evidence="Observed"),
        StatCard(label="Stops on route", value=str(response.get("stop_count", len(stops))), evidence="Observed"),
        *([StatCard(label="Line", value=line_name.title(), evidence="Observed")] if line_name else []),
    ])
    return [map_layer, stats]


# ---------------------------------------------------------------------------
# get_urban_stress_map — default/full choropleth
# ---------------------------------------------------------------------------

def format_urban_stress_map(response: dict, args: dict) -> list[PropusResult]:
    fc = _resolve_geometry(response.get("geometry_ref")) or (
        response if response.get("type") == "FeatureCollection" else EMPTY_FC
    )
    return [MapLayerResult(
        layer="choropleth",
        geojson=fc,
        style=MapStyleSpec(rampProperty="urban_stress_index", opacity=0.7),
        camera={"center": DELHI_CENTER, "zoom": 10},
        label="Urban stress index",
    )]


# ---------------------------------------------------------------------------
# get_ward_rs_profile — single/few ward lookup
# ---------------------------------------------------------------------------

def format_ward_rs_profile(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Not found", value=response["error"], evidence="Calculated", alert=True)])]

    wards = response.get("wards", [])
    if len(wards) == 1:
        w = wards[0]
        return [StatCardsResult(cards=[
            StatCard(label=w["ward_name"], value=str(w.get("transit_score", "N/A")), unit="transit score", evidence="Calculated"),
            StatCard(label="Bus stops", value=str(w.get("bus_stop_count", 0)), evidence="Observed"),
            StatCard(label="Population", value=str(w.get("pop_total", "N/A")), evidence="Estimated"),
            StatCard(label="Metro within 1km", value="Yes" if w.get("has_metro_within_1k") else "No", evidence="Observed"),
        ])]

    columns = ["Ward", "Bus Stops", "Transit Score", "Population"]
    rows = [[w["ward_name"], w.get("bus_stop_count") or 0, w.get("transit_score") or "N/A", w.get("pop_total") or "N/A"] for w in wards]
    return [DataTableResult(columns=columns, rows=rows, evidence="Calculated", rowIds=[w["ward_id"] for w in wards])]


# ---------------------------------------------------------------------------
# Generic fallback — any tool without a dedicated formatter still renders
# something typed, never raw text/JSON.
# ---------------------------------------------------------------------------

def format_generic(response: dict, args: dict) -> list[PropusResult]:
    if "error" in response:
        return [StatCardsResult(cards=[StatCard(label="Error", value=str(response["error"]), evidence="Calculated", alert=True)])]

    list_fields = [(k, v) for k, v in response.items() if isinstance(v, list) and v and isinstance(v[0], dict)]
    if list_fields:
        _, rows_data = list_fields[0]
        columns = list(rows_data[0].keys())
        rows = [[str(r.get(c, "")) for c in columns] for r in rows_data[:50]]
        return [DataTableResult(columns=columns, rows=rows, evidence="Observed")]

    scalar_fields = [(k, v) for k, v in response.items() if isinstance(v, (str, int, float, bool)) and not isinstance(v, dict)]
    if scalar_fields:
        return [StatCardsResult(cards=[
            StatCard(label=k, value=str(v), evidence="Observed") for k, v in scalar_fields[:6]
        ])]

    return [StatCardsResult(cards=[StatCard(label="Result", value="No displayable data", evidence="Observed")])]


FORMATTERS: dict[str, Callable[[dict, dict], list[PropusResult]]] = {
    "find_underserved_areas": format_find_underserved_areas,
    "get_ward_density_ranking": format_ward_density_ranking,
    "get_pop_walk_access": format_pop_walk_access,
    "coverage_gap": format_coverage_gap,
    "compare_transit_access": format_compare_transit_access,
    "get_route_coverage": format_route_coverage,
    "get_metro_catchment": format_catchment,
    "simulate_new_stop_catchment": format_catchment,
    "get_urban_stress_map": format_urban_stress_map,
    "get_ward_rs_profile": format_ward_rs_profile,
}

METHODOLOGY: dict[str, Methodology] = {
    "find_underserved_areas": FIND_UNDERSERVED_METHODOLOGY,
    "get_metro_catchment": CATCHMENT_METHODOLOGY,
    "simulate_new_stop_catchment": CATCHMENT_METHODOLOGY,
    "get_pop_walk_access": WALK_ACCESS_METHODOLOGY,
    "coverage_gap": COVERAGE_GAP_METHODOLOGY,
}


def format_tool_response(tool_name: str, response: Any, args: dict) -> list[PropusResult]:
    if not isinstance(response, dict):
        response = {"value": response}
    formatter = FORMATTERS.get(tool_name, format_generic)
    return formatter(response, args)

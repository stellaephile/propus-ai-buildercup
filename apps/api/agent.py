"""
apps/api/agent.py  (v3 — Supabase + deterministic geo layer)
--------------------------------------------------------------
Google ADK agent for City Transit Intelligence (Propus / Quiver).

This is the single copy of the agent (moved from root agent/agent.py per
CLAUDE.md §10 — apps/api owns FastAPI + agent, no second copy). Ported from
Cloud SQL to Supabase:

  - Connects via AGENT_DATABASE_URL (the read-only, table-allowlisted,
    5s-statement-timeout role — see db/roles.sql), never the owner
    DATABASE_URL. Falls back to DATABASE_URL with a loud warning so local
    dev without the role set up still runs.
  - Catchment / worst-wards / density / choropleth math is delegated to the
    parametrized PostGIS functions in db/functions.sql (fn_worst_wards,
    fn_catchment, fn_ward_density_rank, fn_ward_choropleth) instead of
    free-written SQL (CLAUDE.md §5 / TASKS.md B2.5).
  - get_route_coverage / get_frequency_at_stop no longer join gtfs_bus.
    stop_times for the bus feed (that raw table is deliberately absent from
    schema.sql — 3.7M rows). They use derived.route_stops / derived.
    stop_hourly_frequency instead; metro keeps its raw stop_times join
    since gtfs_metro.stop_times is small enough to load as-is.

Usage:
    # Interactive terminal
    python -m apps.api.agent

    # Single query
    python -m apps.api.agent --query "Which wards have the worst transit access?"

    # As module
    from apps.api.agent import create_runner, run_query

Requires:
    pip install google-adk google-generativeai sqlalchemy psycopg2-binary
                python-dotenv
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import math
import os
import random
import re
import uuid
from collections import OrderedDict
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MODEL CONFIG — two tiers (CLAUDE.md §4: OpenRouter/Groq for cheap routing)
#
# Simple queries (single-tool lookups — the 5 headline shapes) run on
# open-source models via Groq; only genuinely advanced queries (scenario /
# multi-step / open-ended reasoning) escalate to Gemini. Models with a "/"
# are LiteLLM routes (provider/model); bare names are native Gemini.
# ---------------------------------------------------------------------------

MODEL_CHAIN = [
    "gemini-2.5-flash",        # primary (fast + best quality)
    "gemini-2.0-flash",        # different quota bucket (important fallback)
    "gemini-2.5-flash-lite",   # lightweight fallback
    "gemini-2.0-flash-lite",   # cheapest / most permissive
    "gemini-2.5-pro",          # last resort (expensive, slower)
]

SIMPLE_MODEL_CHAIN = [
    "groq/openai/gpt-oss-120b",       # open-weight (Apache-2.0), most reliable tool-caller on Groq
    "groq/qwen/qwen3-32b",            # open-source fallback, solid tool use
    "groq/llama-3.3-70b-versatile",   # last resort — known flaky tool-call syntax (tool_use_failed 400s)
]

def _groq_available() -> bool:
    return bool(os.environ.get("GROQ_API_KEY"))


# Escalation markers: scenario simulation, multi-step reasoning, open-ended
# analysis. Everything else — the direct single-tool lookups — stays on the
# open-source tier.
_ADVANCED_MARKERS = (
    "if ", "what if", "scenario", "simulate", "were added", "was added",
    "why ", "explain", "recommend", "prioriti", "trade-off", "tradeoff",
    "strategy", "plan ", "propose", "and then", "step by step",
)

def classify_complexity(query: str) -> str:
    """'simple' → open-source via Groq; 'advanced' → Gemini chain."""
    s = f" {query.lower().strip()} "
    if any(m in s for m in _ADVANCED_MARKERS):
        return "advanced"
    if s.count("?") > 1 or len(s.split()) > 30:
        return "advanced"
    return "simple"


def pick_model(tier: str = "simple") -> str:
    """Resolve the model name for a tier, honouring the Gemini failure index
    and falling back to Gemini when no GROQ_API_KEY is configured."""
    if tier == "simple" and _groq_available():
        return SIMPLE_MODEL_CHAIN[0]
    if tier == "simple":
        log.warning("GROQ_API_KEY not set — simple queries falling back to Gemini")
    return MODEL_CHAIN[_current_model_idx]


_current_model_idx = 0
_model_failures = {m: 0 for m in MODEL_CHAIN}

FAILURE_THRESHOLD = 2
BASE_DELAY = 2
MAX_DELAY = 30
TIMEOUT_SECONDS = 25
# Per-call bound on the actual HTTP request to Groq (see _make_litellm_model).
# Without this, a stuck Groq call had no timeout of its own — it just rode
# along until the outer asyncio.timeout(TIMEOUT_SECONDS) cancelled the whole
# agent turn, surfacing as a generic "Agent turn exceeded 25s timeout" with no
# indication of what was actually slow. Shorter than TIMEOUT_SECONDS so a
# genuinely stuck Groq call fails — with a real litellm.Timeout naming Groq
# specifically — while there's still time left in the outer budget to
# escalate to Gemini within the same turn.
GROQ_TIMEOUT_SECONDS = 15

# ---------------------------------------------------------------------------
# SHARED SESSION SERVICE
# ---------------------------------------------------------------------------

from google.adk.sessions import InMemorySessionService
_session_service = InMemorySessionService()


# ---------------------------------------------------------------------------
# DB ENGINE — read-only role, never the owner connection (CLAUDE.md §5.3)
# ---------------------------------------------------------------------------

_engine = None


def get_engine():
    global _engine
    if _engine is None:
        db_url = os.environ.get("AGENT_DATABASE_URL")
        if not db_url:
            log.warning(
                "AGENT_DATABASE_URL not set — falling back to DATABASE_URL "
                "(the agent should use the read-only role in any real deploy; "
                "see db/roles.sql)"
            )
            db_url = os.environ["DATABASE_URL"]
        # The image ships psycopg2 only. A "postgresql+psycopg://" (psycopg 3)
        # URL would make SQLAlchemy import a driver that is not installed, so
        # pin whichever spelling the secret uses to the installed driver.
        # Secrets often carry stray whitespace or quotes, which defeated a
        # plain startswith() check and surfaced as "No module named 'psycopg'".
        db_url = re.sub(
            r"^postgres(?:ql)?(?:\+\w+)?://", "postgresql+psycopg2://",
            db_url.strip().strip("'\""),
        )
        _engine = create_engine(
            db_url,
            pool_pre_ping=True,
            pool_size=3,
            max_overflow=2,
            pool_recycle=1800,
            # db/roles.sql sets statement_timeout='5s', but that only bounds
            # query EXECUTION once connected — it does nothing for the TCP
            # connect phase. With no connect_timeout, an unreachable Postgres
            # (a paused Supabase free-tier project, a stale host, a network
            # ACL silently dropping SYNs) hangs psycopg2's connect() for the
            # platform's own default (60s+, sometimes much longer) — and
            # since `_q()` calls this synchronously with no thread/executor
            # offload, that hang freezes the whole asyncio event loop: no
            # further SSE events, no timeout, no error, just silence until
            # the front-end proxy eventually kills the connection. Observed
            # in prod: one "Analysing your question..." step, then nothing
            # for 90+ seconds. 5s here means a genuinely unreachable DB now
            # fails fast enough to surface as a real ErrorEvent instead.
            connect_args={"connect_timeout": 5},
        )
    return _engine


# ---------------------------------------------------------------------------
# Geometry side-channel — the LLM never sees polygons.
#
# Tool responses are round-tripped through the model as conversation content,
# so embedding ward/buffer GeoJSON blows small-context providers (Groq free
# tier 413s on it) and burns Gemini tokens for nothing: only the formatter
# and the map need geometry. Tools stash geometry here and return a short
# ref string; apps/api/formatters.py resolves it back before building the
# typed map_layer result. In-process and bounded — refs live exactly as long
# as the request that created them needs.
# ---------------------------------------------------------------------------

_GEOM_STASH: OrderedDict[str, object] = OrderedDict()
_GEOM_STASH_MAX = 32


def _stash_geometry(obj: object) -> str:
    ref = f"geom_{uuid.uuid4().hex[:12]}"
    _GEOM_STASH[ref] = obj
    while len(_GEOM_STASH) > _GEOM_STASH_MAX:
        _GEOM_STASH.popitem(last=False)
    return ref


def get_stashed_geometry(ref: str | None) -> object | None:
    if not ref:
        return None
    return _GEOM_STASH.get(ref)


def _q(sql: str, params: dict | None = None) -> list[dict]:
    from decimal import Decimal
    import datetime

    def _coerce(v):
        if isinstance(v, Decimal): return float(v)
        if isinstance(v, (datetime.date, datetime.datetime)): return v.isoformat()
        return v

    with get_engine().connect() as conn:
        result = conn.execute(text(sql), params or {})
        cols = list(result.keys())
        return [{c: _coerce(v) for c, v in zip(cols, row)} for row in result.fetchall()]


# pg_trgm similarity floor for ward-name fallback; 0.35 keeps real
# misspellings ("Sangam Vihaar" 0.8, "Kashmiri Gate" 0.56, "Rohni" 0.44)
# while rejecting unrelated names.
_WARD_FUZZY_THRESHOLD = 0.35


def _match_ward_ids(name: str) -> tuple[list[str], str]:
    """Resolve a user-supplied area name to ward_ids.

    Tries exact ward_id/name and substring LIKE first, then falls back to
    pg_trgm trigram similarity so misspellings still resolve.
    Returns (ward_ids, method) with method one of "like" | "fuzzy".

    Inputs under 3 chars only get the exact pass: a bare "a" (or a stray
    "%"/"_" wildcard) would otherwise LIKE-match most of the city and be
    aggregated as if it were one area.
    """
    q = (name or "").strip()
    if not q:
        return [], "like"

    if len(q) < 3:
        rows = _q("""
            SELECT ward_id FROM derived.ward_metrics
            WHERE UPPER(ward_name) = UPPER(:q) OR ward_id = :q
            ORDER BY ward_name
        """, {"q": q})
        return [r["ward_id"] for r in rows], "like"

    esc = q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_")
    rows = _q("""
        SELECT ward_id FROM derived.ward_metrics
        WHERE UPPER(ward_name) = UPPER(:q) OR ward_id = :q
           OR UPPER(ward_name) LIKE UPPER(:pat)
        ORDER BY ward_name
    """, {"q": q, "pat": f"%{esc}%"})
    if rows:
        return [r["ward_id"] for r in rows], "like"

    rows = _q("""
        SELECT ward_id, similarity(ward_name, :q) AS sim
        FROM derived.ward_metrics
        WHERE similarity(ward_name, :q) > :t
        ORDER BY sim DESC, ward_name
        LIMIT 5
    """, {"q": q, "t": _WARD_FUZZY_THRESHOLD})
    if not rows:
        return [], "fuzzy"
    # Keep only candidates near the best score — a 0.8 hit shouldn't drag
    # along loosely-related 0.4 names (e.g. SANGAM PARK for "Sangam Vihaar").
    top = rows[0]["sim"]
    return [r["ward_id"] for r in rows if r["sim"] >= top - 0.2], "fuzzy"


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are the City Transit Intelligence Agent for Propus/Quiver,
a WRI India transit equity analysis platform.

GLOSSARY: "PT" = public transit/transport (bus + metro combined). "Walk access" /
"walkable" / "on foot" / "within walking distance" all mean the same thing —
route to get_pop_walk_access when the question is about a population share,
regardless of which of these words is used.

REAL DATA IN DATABASE (verified against official sources 2026-09-07 — see
docs/TASKS.md B2.6 for the check):
- 6,880 bus stops (distinct boarding points/stop_code; the raw feed has
  10,559 rows because the same physical pole appears once per serving route
  — never say "10,559 bus stops"). 2,403 bus route×direction×variant entries
  in the feed — NOT 2,403 distinct routes; there's no dedup key for routes
  the way stop_code exists for stops, so don't state a specific "real" route
  count. If asked, say officially DTC operates ~259 routes and Delhi's
  combined DTC+DIMTS network is ~606 routes (external 2023 figure, not
  verified against this feed's vintage).
- 262 metro stops. 11 distinct lines in this feed (grouping by color code);
  DMRC's own current official count is 12 lines. Our "AQUA" group is Noida's
  Aqua Line — DMRC's own account states that line does NOT come under DMRC
  (it's NMRC) — don't attribute it to DMRC if asked specifically.
- 290 Delhi ward polygons with computed transit metrics
- WorldPop 2020 population (pop_total, stops_per_10k)
- Sentinel-2 NDVI/NDBI urban stress indices — currently NULL for all wards
  (RS pipeline not yet run in this environment); urban_stress_index falls
  back to a transit-only score when NDVI/NDBI are missing. Always say so
  when reporting urban_stress_index.

KEY FACTS:
- Stop IDs: bus stops = 'bus_<n>', metro stops = 'metro_<n>'
- Transit scores: 0–1 (higher = better)
- 23 wards have zero bus stops (Sangam Vihar cluster, Tigri, Raj Nagar etc.)
- urban_stress_index > 0.7 = highest intervention priority

WARD NAMES — CRITICAL:
Ward names in the DB are ALL CAPS and use official MCD names, NOT common
colloquial names. Popular area names map like this:
  "Rohini"       → search "ROHINI" (matches ROHINI, ROHINI EAST/WEST/NORTH/SOUTH)
  "Mustafabad"   → exact match "MUSTAFABAD" ✓
  "Sangam Vihar" → matches SANGAM VIHAR, SANGAM VIHAR EAST/WEST/CENTRAL
  "Karol Bagh"   → exact match "KAROL BAGH" ✓
Note: "Dwarka" does NOT exist in this dataset's 290 wards (it is a sub-city,
not an MCD ward — verified 2026-07-11); never claim a match for it.
"Seemapuri" fuzzy-resolves to the ward NEW SEEMA PURI — use it and say so.

GEOCODING — both directions are DB-native, no external call needed for
known wards:
- "What area/ward is (lat, lon) in?" → reverse_geocode(lat, lon, buffer_m).
  Exact polygon match first; if the point falls just outside every ward
  (GPS noise, a boundary rounding error) it falls back to the nearest ward
  within buffer_m (default 200m) and reports match_type + distance_m so you
  can flag low confidence.
- "Where is [area]?" / "coordinates of [area]" → geocode_neighbourhood(name).
  Returns the ward polygon's centroid — same LIKE + fuzzy name matching as
  get_ward_rs_profile, so misspellings resolve the same way.
- Only if geocode_neighbourhood finds no match at all (a landmark or street
  address, not one of the 290 MCD wards) → geocode_location(query) as a
  last resort via Google's Geocoding API, then call get_nearby_stops(lat,
  lon) on the result. Never say "location not found" without trying
  geocode_neighbourhood first, then geocode_location. Always state the
  returned precision: "approximate area" is a locality centre, not the exact
  place. If ambiguous is true, name the alternatives and confirm. Never pass
  coordinates to geocode_location; use reverse_geocode.

When a user mentions an area name:
1. ALWAYS call get_ward_rs_profile(area_name) first — it uses LIKE matching
   plus trigram fuzzy matching, so partial names AND misspellings
   ("Sangam Vihaar", "Kashmiri Gate") will resolve. NEVER tell the user the
   area doesn't exist without trying this tool first. If the result carries
   a fuzzy-match note, tell the user which ward name you matched.
2. If get_ward_rs_profile returns multiple matches (e.g. DWARKA SECTOR 1..20),
   summarise them as a group or pick the most central one.
3. For "how far is X from metro" → call get_ward_rs_profile(X) to get the
   ward centroid, then interpret has_metro_within_1k and multimodal_gap_count.
   DO NOT call semantic_stop_search for area/neighbourhood queries.
4. For "compare X vs Y" → call compare_transit_access(A, B) which handles
   LIKE matching and aggregates multiple ward matches automatically.

TOOL ROUTING:
- "Worst wards" / "underserved areas"  → find_underserved_areas(metric, threshold)
- "BEST transit access" / "best served" → get_ward_density_ranking(top_n, metric='transit_score')
  (transit_score is the access metric — never answer "best access" with raw stop counts)
- "Top N wards by stop density/count"  → get_ward_density_ranking(top_n, metric='bus_stop_count')
- "% / how much / how many people have PT access by walk / on foot / within
  walking distance" (any phrasing of a population share reachable on foot,
  city-wide — "PT" = public transit) → get_pop_walk_access(bus_radius_m=500,
  metro_radius_m=800) (defaults are 500m walk to a bus stop / 800m walk to a
  metro station; override either if the user names a distance, e.g. "within
  300m of a bus stop"). Do not confuse with get_metro_catchment/
  simulate_network_change, which are for ONE station/point, not city-wide.
- "What share / how many people live MORE THAN X m from transit", "who is
  far from transit", "biggest areas without a metro within 1 km", "coverage
  gaps" → coverage_gap(bus_radius_m=500, metro_radius_m=800, mode, top_n)
  (mode='metro' with metro_radius_m=1000 for "no metro within 1 km"). Uses
  WorldPop 100 m cells, so it is the finer-grained answer for population
  BEYOND walking distance and for WHERE the gaps are.
- "Hot stops" / "stops in extreme heat" / "busiest stops on the hottest
  surfaces" / "share of trips at hot stops" → stop_heat_exposure(sd, mode,
  limit, min_trips). sd=1.0 by default; raise it (1.5, 2.0) for "only the
  hottest", lower it (0.5) for a looser cut. Leave threshold_c UNSET unless
  the user names a temperature.
  It is Landsat LAND SURFACE temperature (relative indicator), not air
  temperature - say so, and never call these stops "extreme" or "dangerous".
- Air quality, ridership counts, income, felt heat / UTCI, shade or shelter
  inventory: NO tool has this data. Say you do not have it; never estimate.
- "How far is [area] from metro?"      → get_ward_rs_profile(area_name)
- "Tell me about [area]"               → get_ward_rs_profile(area_name)
- "Compare [A] vs [B]"                 → compare_transit_access(A, B)
- "Stops near lat/lon"                 → get_nearby_stops(lat, lon, radius_m)
- "What area/ward is at lat/lon?"      → reverse_geocode(lat, lon, buffer_m)
- "Route [id] details"                 → get_route_coverage(route_id)
- "Metro [station] catchment"          → get_metro_catchment(station_name) (always draws
  the combined 500m + 800m rings, not a single radius — override
  bus_radius_m/metro_radius_m only if the user names different distances)
- "If a metro/bus stop is added at X"  → simulate_network_change(add_at=["lon,lat" or ward
  name], add_mode) (reports people newly covered and draws the new stop's walk buffer)
- "Frequency at stop [id]"             → get_frequency_at_stop(stop_id, start, end)
- "Bus stops far from metro"           → find_multimodal_gaps(max_distance_m)
- "Where is [area]? / centroid of [area]" → geocode_neighbourhood(name)
- "Geocode a landmark/address"         → geocode_location(query) — only after geocode_neighbourhood misses
- "Search for stop named [x]"          → semantic_stop_search(query_text)
- "Show full Delhi map"                → get_urban_stress_map()

GROUNDING RULES (never break these):
- Every number you state must come from a tool result in THIS conversation. Never
  estimate, round up from memory, or use outside knowledge for a figure.
- Report the tool's "method" line in one short sentence when it gives one.
- Heat values are Landsat LAND SURFACE temperature, a relative indicator - not air
  temperature or felt heat. Say so when you report them.
- If a question needs data no tool has (air quality, ridership counts, income,
  felt heat/UTCI, shade or shelter inventory, anything outside Delhi bus/metro
  access, population coverage and stop surface heat), do NOT call a tool and do NOT
  guess: say in ONE plain sentence that Propus does not have that data.
- Coordinates in a result are shown on the map; do not repeat them in prose.

EQUITY FRAMING: Always prefer stops_per_10k over raw counts when available.
Note when RS metrics (ndvi_mean, ndbi_mean) are NULL — means the RS pipeline
hasn't run yet for that ward, and urban_stress_index is transit-only.
"""

# ---------------------------------------------------------------------------
# Tools — plain Python functions, ADK wraps them automatically
# ---------------------------------------------------------------------------

def get_nearby_stops(lat: float, lon: float, radius_m: int = 500) -> dict:
    """Return bus and metro stops within radius_m metres of (lat, lon).

    Args:
        lat: Latitude (WGS84 decimal degrees).
        lon: Longitude (WGS84 decimal degrees).
        radius_m: Search radius in metres (default 500).

    Returns:
        count and list of nearby stops sorted by distance.
    """
    rows = _q("""
        SELECT stop_id, stop_name, feed,
               stop_lat AS lat, stop_lon AS lon,
               ROUND(ST_Distance(
                   geom::geography,
                   ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
               ))::int AS distance_m
        FROM (
            SELECT stop_id, stop_name, 'bus'   AS feed, stop_lat, stop_lon, geom
            FROM gtfs_bus.stops
            UNION ALL
            SELECT stop_id, stop_name, 'metro' AS feed, stop_lat, stop_lon, geom
            FROM gtfs_metro.stops
        ) s
        WHERE ST_DWithin(
            geom::geography,
            ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
            :r
        )
        ORDER BY distance_m ASC
        LIMIT 50
    """, {"lat": lat, "lon": lon, "r": radius_m})
    return {"count": len(rows), "stops": rows}


def reverse_geocode(lat: float, lon: float, buffer_m: int = 200) -> dict:
    """Resolve a (lat, lon) point to the Delhi ward that contains it.

    Args:
        lat: Latitude (WGS84 decimal degrees).
        lon: Longitude (WGS84 decimal degrees).
        buffer_m: If the point isn't inside any ward polygon (GPS noise, a
            point just past a boundary), search this far for the nearest
            ward instead (default 200m, clamped to 2000m).

    Returns:
        ward_id, ward_name, match_type ('exact' | 'buffered'), distance_m
        (0 for exact). error if nothing is within buffer_m of any ward —
        the point is genuinely outside Delhi's 290 mapped wards.
    """
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return {"error": "Latitude and longitude must be real numbers."}
    # Delhi is near 28.6 N, 77.2 E; a swapped pair or a stray value lands far outside.
    if not (28.40 <= lat <= 28.88 and 76.84 <= lon <= 77.35):
        return {"error": f"({lat}, {lon}) is outside Delhi. Latitude comes first; Delhi is near 28.6 N, 77.2 E."}
    buffer_m = min(max(int(buffer_m), 0), 2000)
    try:
        rows = _q(
            "SELECT * FROM fn_reverse_geocode(:lon, :lat, :buf)",
            {"lon": lon, "lat": lat, "buf": buffer_m},
        )
    except Exception:
        # Pre-migration fallback: fn_reverse_geocode (db/functions.sql)
        # isn't applied yet — same exact-then-buffered logic inline.
        buf = min(max(buffer_m, 0), 2000)
        rows = _q("""
            SELECT ward_id, ward_name, 'exact' AS match_type, 0 AS distance_m
            FROM public.wards
            WHERE ST_Within(ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), geometry)
            LIMIT 1
        """, {"lon": lon, "lat": lat})
        if not rows:
            rows = _q("""
                SELECT ward_id, ward_name, 'buffered' AS match_type,
                       ROUND(ST_Distance(
                           geometry::geography,
                           ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
                       ))::int AS distance_m
                FROM public.wards
                WHERE ST_DWithin(
                    geometry::geography,
                    ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
                    :buf
                )
                ORDER BY geometry::geography <->
                         ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography
                LIMIT 1
            """, {"lon": lon, "lat": lat, "buf": buf})
    if not rows:
        return {"error": f"({lat}, {lon}) is not within {buffer_m}m of any mapped ward"}
    r = rows[0]
    if r["match_type"] == "buffered":
        r["note"] = f"Point falls outside every ward polygon — nearest ward is {r['distance_m']}m away."
    return r


def geocode_neighbourhood(name: str) -> dict:
    """Resolve a Delhi ward/neighbourhood name to a representative point.

    Args:
        name: Ward or neighbourhood name (case-insensitive; partial and
            fuzzy-misspelled names resolve — same matching as
            get_ward_rs_profile, see WARD NAMES above).

    Returns:
        ward_id, ward_name, lat, lon for each matched ward. The point is
        ST_PointOnSurface, not the polygon centroid — some MCD ward
        polygons are concave/multi-part enough that their true centroid
        falls outside the ward (13 of 290 checked), which would hand back
        a coordinate that isn't actually in the place it's labelled as.
        PointOnSurface always lands inside. If the name matches several
        wards (e.g. "Dwarka" → SECTOR 1..20), returns a point per ward, not
        one averaged location — see `note` when multiple wards match.
    """
    ward_ids, method = _match_ward_ids(name)
    if not ward_ids:
        return {"error": f"No ward found matching '{name}'"}
    rows = _q("""
        SELECT ward_id, ward_name,
               ROUND(ST_Y(ST_PointOnSurface(geometry))::numeric, 6) AS lat,
               ROUND(ST_X(ST_PointOnSurface(geometry))::numeric, 6) AS lon
        FROM public.wards
        WHERE ward_id = ANY(:ids)
        ORDER BY array_position(:ids, ward_id)
        LIMIT 20
    """, {"ids": ward_ids})
    out = {"matches": len(rows), "wards": rows}
    if method == "fuzzy":
        out["note"] = (f"No exact match for '{name}' — closest ward names "
                       "by trigram similarity; confirm with the user if ambiguous.")
    elif len(rows) > 1:
        out["note"] = (f"'{name}' matched {len(rows)} wards — returning a point "
                        "per ward, not one averaged location; confirm which one "
                        "the user means before treating this as a single place.")
    return out


# Google location_type -> plain-language precision, so the caller never
# presents a locality centre as if it were the place itself.
_GEOCODE_PRECISION = {
    "ROOFTOP": "exact address",
    "RANGE_INTERPOLATED": "street segment (interpolated)",
    "GEOMETRIC_CENTER": "place or street (centre point)",
    "APPROXIMATE": "approximate area (centre of a locality, not a specific place)",
}
# A hit whose only meaning is the whole city/state/country is Google's
# fallback for an unmatched query, never a real answer.
_GEOCODE_TOO_COARSE = {"administrative_area_level_1", "administrative_area_level_2", "country"}
_COORDINATE_QUERY = re.compile(r"^\s*-?\d+(\.\d+)?\s*[,\s]\s*-?\d+(\.\d+)?\s*$")


def _google_geocode(query: str, api_key: str) -> dict:
    """Blocking HTTP call; run it with asyncio.to_thread, never on the loop."""
    import json
    import urllib.parse
    import urllib.request

    params = urllib.parse.urlencode({
        "address": f"{query}, Delhi, India",
        "bounds": "28.40,76.84|28.88,77.35",       # SW|NE, a bias only
        "components": "administrative_area:Delhi|country:IN",  # a hard filter
        "key": api_key,
    })
    with urllib.request.urlopen(
        f"https://maps.googleapis.com/maps/api/geocode/json?{params}", timeout=5
    ) as resp:
        return json.loads(resp.read().decode())


async def geocode_location(query: str) -> dict:
    """Geocode a Delhi landmark or street address via Google's Geocoding API.
    Fallback for places that are not one of the 290 MCD wards; try
    geocode_neighbourhood first (free, exact, grounded in this DB's polygons).

    Args:
        query: Place name or address (e.g. 'Lajpat Nagar', 'Kashmere Gate
            metro station'). Not coordinates; use reverse_geocode for those.

    Returns:
        lat, lon, formatted_address, location_type and precision. ALWAYS tell
        the user the precision: 'approximate area' means a locality centre,
        not the exact place. ambiguous=true with other_matches means several
        places fit; confirm which one. partial_match=true means Google matched
        only part of the query; show formatted_address and confirm. ward_id/ward_name give the containing
        MCD ward, or null when the point is outside the mapped wards (for
        example NDMC or Cantonment areas). error when nothing reliable matched.
    """
    query = (query or "").strip()
    if not query:
        return {"error": "Empty query. Ask the user which place they mean."}
    if _COORDINATE_QUERY.match(query):
        return {"error": "That looks like coordinates. Use reverse_geocode(lat, lon) instead."}

    api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    if not api_key:
        return {"error": "GOOGLE_MAPS_API_KEY not configured"}

    try:
        data = await asyncio.to_thread(_google_geocode, query, api_key)
    except Exception as exc:
        # Type only: some urllib errors carry the request URL, which holds the key.
        return {"error": f"Geocoding request failed ({type(exc).__name__})"}

    status, results = data.get("status"), data.get("results") or []
    if status == "ZERO_RESULTS" or (status == "OK" and not results):
        return {"error": f"No place found for '{query}' in Delhi."}
    if status != "OK":
        return {"error": f"Geocoding returned status={status} for '{query}'"}

    top = results[0]
    if _GEOCODE_TOO_COARSE & set(top.get("types", [])):
        return {"error": f"'{query}' resolved only to a whole city or region, not a place. "
                         "Ask the user for a more specific place."}
    # The components filter is not enforced by Google, and Noida / Faridabad
    # fall inside Delhi's bounding box, so require Delhi in the address itself.
    if not any("administrative_area_level_1" in c.get("types", []) and c.get("long_name") == "Delhi"
               for c in top.get("address_components", [])):
        return {"error": f"'{query}' resolved to '{top.get('formatted_address', '')}', "
                         "which is outside Delhi."}

    loc = top["geometry"]["location"]
    lat, lon = loc["lat"], loc["lng"]
    # Backstop for the components filter: Delhi's bounding box.
    if not (28.40 <= lat <= 28.88 and 76.84 <= lon <= 77.35):
        return {"error": f"Geocoded location ({lat}, {lon}) is outside Delhi bounds"}

    loc_type = top["geometry"].get("location_type", "APPROXIMATE")
    out = {
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "formatted_address": top.get("formatted_address", ""),
        "location_type": loc_type,
        "precision": _GEOCODE_PRECISION.get(loc_type, loc_type),
        "ambiguous": len(results) > 1,
        "partial_match": bool(top.get("partial_match")),
    }
    if len(results) > 1:
        out["other_matches"] = [r.get("formatted_address", "") for r in results[1:4]]

    # Ward is informational: NDMC and Cantonment land is outside the MCD
    # wards, so a miss here must not reject an otherwise valid place.
    try:
        ward = await asyncio.to_thread(reverse_geocode, lat, lon, 100)
    except Exception as exc:
        log.warning(f"geocode_location ward lookup failed: {type(exc).__name__}")
        ward = {"error": "ward lookup unavailable"}
    if "error" in ward:
        out.update(ward_id=None, ward_name=None,
                   note="Point is outside the mapped MCD wards (e.g. NDMC or Cantonment) "
                        "or the ward lookup was unavailable.")
    else:
        out.update(ward_id=ward["ward_id"], ward_name=ward["ward_name"],
                   ward_match_type=ward["match_type"])
    return out


def find_underserved_areas(
    metric: str = "transit_score",
    threshold: float = 0.15,
    top_n: int = 15,
) -> dict:
    """Find Delhi wards underserved by public transit (query #1: worst wards).

    Args:
        metric: 'transit_score', 'stops_per_10k', 'bus_physical_stop_count'
            (de-duplicated physical stop locations), 'physical_stop_density_per_km2',
            or 'bus_stop_count' (LEGACY raw GTFS rows, ~2.6x inflated).
        threshold: Max value of metric to count as underserved (informational
            only — fn_worst_wards ranks ascending regardless; threshold is
            reported back for the caller's own display, not enforced in SQL).
        top_n: Number of wards to return.

    Returns:
        List of the top_n worst-ranked wards with transit and population
        metrics. Ward geometry goes to the map via geometry_ref, not inline.
    """
    rows = _q(
        "SELECT * FROM fn_worst_wards(:metric, :n)",
        {"metric": metric, "n": top_n},
    )
    geoms = {r["ward_id"]: r.pop("geometry", None) for r in rows}
    return {
        "count": len(rows),
        "metric": metric,
        "threshold": threshold,
        "wards": rows,
        "geometry_ref": _stash_geometry(geoms),
    }


_RANK_METRICS = (
    "bus_physical_stop_count", "physical_stop_density_per_km2",
    "bus_stop_count", "stops_per_10k", "transit_score",
)


def get_ward_density_ranking(
    top_n: int = 10, metric: str = "bus_physical_stop_count"
) -> dict:
    """Rank Delhi wards by a transit metric, HIGHEST first.

    Args:
        top_n: Number of wards to return (default 10).
        metric: 'bus_physical_stop_count' (DEFAULT — distinct physical stop
            locations after de-duplication; use this for any "how many stops"
            or "stop density" question), 'physical_stop_density_per_km2'
            (those stops per km2), 'transit_score' (use for "best transit
            access" — the composite access metric), 'stops_per_10k' (the
            population-weighted equity view), or 'bus_stop_count' (LEGACY raw
            GTFS row count — inflated ~2.6x by per-route and per-direction
            duplicate records; use only if the user explicitly asks for raw
            GTFS records).

    Returns:
        Top-N wards, highest metric first, with geometry_ref so the map can
        highlight them.
    """
    if metric not in _RANK_METRICS:
        return {"error": f"metric must be one of {list(_RANK_METRICS)}"}
    try:
        rows = _q(
            "SELECT * FROM fn_ward_density_rank(:metric, :n)",
            {"metric": metric, "n": top_n},
        )
    except Exception:
        # Pre-migration fallback: the two-arg fn_ward_density_rank from
        # db/functions.sql isn't applied yet. Same allowlisted ranking —
        # `metric` is tuple-checked above, never free text.
        rows = _q(f"""
            SELECT wm.ward_id, wm.ward_name, wm.bus_stop_count,
                   ROUND(wm.transit_score::numeric, 4) AS transit_score,
                   wm.pop_total,
                   ROUND(wm.stops_per_10k::numeric, 4) AS stops_per_10k,
                   ST_AsGeoJSON(_simplify_round(w.geometry), 5)::json AS geometry
            FROM derived.ward_metrics wm
            JOIN public.wards w ON w.ward_id = wm.ward_id
            ORDER BY wm.{metric} DESC NULLS LAST
            LIMIT :n
        """, {"n": min(max(top_n, 1), 50)})
    geoms = {r["ward_id"]: r.pop("geometry", None) for r in rows}
    return {
        "count": len(rows),
        "metric": metric,
        "wards": rows,
        "geometry_ref": _stash_geometry(geoms),
    }


def get_pop_walk_access(bus_radius_m: int = 500, metro_radius_m: int = 800) -> dict:
    """City-wide + per-ward % of Delhi's population within walking distance
    of transit (PT). Use for ANY phrasing of this question: "how much/how
    many/what % of the population has PT access by walk", "walkable access
    to transit", "population within walking distance of a bus/metro stop",
    "on-foot access to public transit" — all route here. This is a CITY-WIDE
    aggregate; for the catchment/population reachable around ONE specific
    station or point, use get_metro_catchment or simulate_network_change
    instead.

    Args:
        bus_radius_m: Walking radius to a bus stop, in metres (default 500).
        metro_radius_m: Walking radius to a metro station, in metres
            (default 800). Both are the standard walk-access benchmarks but
            either can be overridden if the user asks for a different
            distance (e.g. "within 300m of a bus stop").

    Returns:
        City-wide pop_total / pop_covered / pct_covered — the numbers to
        report in prose. Map geometry is NOT included here; it's stashed via
        buffer_ref (the actual walkshed polygon — bus + metro buffers unioned
        — is what the map should render, a per-ward choropleth overstates
        coverage) and wards_ref (per-ward breakdown, kept for a future
        attribute-inspection view, not currently mapped). Sending all 290
        wards inline blew a small-context provider's token budget in testing
        (Groq 400 context_length_exceeded) — the LLM only ever needs the
        aggregate to answer this question. Population uses the same areal-
        weighted WorldPop approximation as get_metro_catchment (uniform
        density within a ward) — always state that caveat when reporting.
    """
    rows = _q(
        "SELECT * FROM fn_pop_walk_access(:bus_r, :metro_r)",
        {"bus_r": bus_radius_m, "metro_r": metro_radius_m},
    )
    pop_total = sum(r["pop_total"] for r in rows if r["pop_total"])
    pop_covered = sum(r["pop_covered"] for r in rows if r["pop_covered"])
    pct_covered = round(100 * pop_covered / pop_total, 2) if pop_total else None
    buffer_geojson = rows[0].pop("coverage_geometry", None) if rows else None
    for r in rows:
        r.pop("coverage_geometry", None)
    return {
        "bus_radius_m": bus_radius_m,
        "metro_radius_m": metro_radius_m,
        "city_pop_total": pop_total,
        "city_pop_covered": pop_covered,
        "city_pct_covered": pct_covered,
        "ward_count": len(rows),
        "wards_ref": _stash_geometry(rows),
        "buffer_ref": _stash_geometry(buffer_geojson),
    }


COVERAGE_GAP_METHOD = (
    "WorldPop 2020 100 m cells; straight-line distance to the nearest bus stop "
    "location or metro station, EPSG:32643"
)


def coverage_gap(
    bus_radius_m: int = 500,
    metro_radius_m: int = 800,
    mode: str = "any",
    top_n: int = 10,
) -> dict:
    """How many people in Delhi live BEYOND walking distance of transit, and
    WHERE the biggest gaps are. Use for "what share / how many people live more
    than X m from a bus or metro stop", "who is far from transit", "biggest
    areas without a metro station within 1 km", "transit coverage gaps".

    Args:
        bus_radius_m: Walk radius to a bus stop in metres (default 500,
            clamped 200-1500).
        metro_radius_m: Walk radius to a metro station in metres (default 800,
            clamped 200-1500).
        mode: 'any' (unserved = beyond BOTH radii), 'bus' (beyond the bus
            radius) or 'metro' (beyond the metro radius).
        top_n: Number of largest unserved 1 km clusters to return (1-25).

    Returns:
        total_population, unserved_population, unserved_share_pct and
        top_gap_clusters (unserved_pop, avg_dist_m, lon, lat) — report only
        these numbers, and always state the method line.
    """
    r = _q(
        "SELECT fn_coverage_gap(:b, :m, :mode, :n) AS r",
        {"b": bus_radius_m, "m": metro_radius_m, "mode": mode, "n": top_n},
    )[0]["r"]
    return {
        "mode": r["mode"],
        "bus_radius_m": r["bus_radius_m"],
        "metro_radius_m": r["metro_radius_m"],
        "total_population": r["total_population"],
        "unserved_population": r["unserved_population"],
        "unserved_share_pct": r["unserved_share_pct"],
        "top_gap_clusters": r["clusters"],
        "method": COVERAGE_GAP_METHOD,
    }


STOP_HEAT_METHOD = (
    "Landsat 8/9 Collection 2 summer (Apr-Jun 2023-25) median land surface temperature, "
    "mean within 100 m of each stop"
)


def stop_heat_exposure(
    sd: float = 1.0,
    threshold_c: float | None = None,
    min_trips: int = 0,
    mode: str = "any",
    limit: int = 20,
) -> dict:
    """Which transit stops sit on the hottest surfaces, busiest first, and what
    share of daily trips call at them. Use for "hot stops", "stops in extreme
    heat", "which busy stops are on the hottest surfaces", "share of trips at
    hot stops", "heat exposure at bus stops / metro stations".

    Heat values are LAND SURFACE temperature from Landsat, a relative indicator
    - NOT air temperature or felt heat. Always say so, and say "among the
    hottest surfaces in Delhi", never "extreme" or "dangerous" heat.

    Args:
        sd: How many standard deviations above the city mean counts as hot
            (0-3, default 1.0 = about 43 degC; 0.5 hotter-than-average,
            1.5 or 2.0 = only the very hottest stops). Use it for "hotter",
            "only the hottest", "less strict", "2 SD" style requests.
        threshold_c: Optional fixed surface-temperature cut in degC (clamped
            30-60). OMIT it unless the user names a temperature; it overrides sd.
        min_trips: Only stops with at least this many scheduled trips per day.
        mode: 'any', 'bus' or 'metro'.
        limit: Number of stops to return, busiest first (1-50).

    Returns:
        threshold_c and threshold_basis, stops_above_threshold, stops_total,
        share_of_daily_trips_at_hot_stops_pct and top_stops (name, mode,
        lst_c, trips_day, lon, lat). Trips are scheduled GTFS trips, not
        ridership. Report only these numbers and state the method line.
    """
    r = _q(
        "SELECT fn_stop_heat_exposure(:th, :mt, :mode, :lim, :sd) AS r",
        {"th": threshold_c, "mt": min_trips, "mode": mode, "lim": limit, "sd": sd},
    )[0]["r"]
    return {
        "mode": r["mode"],
        "threshold_c": r["threshold_c"],
        "threshold_basis": r["threshold_basis"],
        "threshold_sd": r["threshold_sd"],
        "city_mean_lst_c": r["city_mean_lst_c"],
        "city_sd_lst_c": r["city_sd_lst_c"],
        "stops_total": r["stops_total"],
        "stops_above_threshold": r["stops_above_threshold"],
        "share_of_stops_above_threshold_pct": r["share_of_stops_above_threshold_pct"],
        "share_of_daily_trips_at_hot_stops_pct": r["share_of_daily_trips_at_hot_stops_pct"],
        "top_stops": r["stops"],
        "method": STOP_HEAT_METHOD,
    }


def get_route_coverage(route_id: str) -> dict:
    """Return all stops on a bus/metro route with shape GeoJSON.

    Args:
        route_id: GTFS route_id e.g. 'bus_142' or 'metro_BL'.

    Returns:
        Route metadata, ordered stop list, and shape GeoJSON LineString.

    Note: bus stop ordering comes from derived.route_stops (one
    representative trip per route, precomputed locally) rather than a live
    gtfs_bus.stop_times join — that raw table is deliberately absent from
    schema.sql. Metro still queries its raw stop_times/trips directly.
    """
    schema = "gtfs_metro" if route_id.startswith("metro_") else "gtfs_bus"
    routes = _q(
        f"SELECT route_id, route_short_name, route_long_name, route_type "
        f"FROM {schema}.routes WHERE route_id = :rid",
        {"rid": route_id},
    )
    if not routes:
        return {"error": f"Route '{route_id}' not found"}

    if schema == "gtfs_bus":
        stops = _q("""
            SELECT rs.stop_sequence, s.stop_id, s.stop_name,
                   s.stop_lat AS lat, s.stop_lon AS lon
            FROM derived.route_stops rs
            JOIN gtfs_bus.stops s ON s.stop_id = rs.stop_id
            WHERE rs.route_id = :rid AND rs.feed = 'bus'
            ORDER BY rs.stop_sequence ASC
            LIMIT 200
        """, {"rid": route_id})
    else:
        stops = _q("""
            SELECT DISTINCT ON (st.stop_sequence, s.stop_id)
                st.stop_sequence, s.stop_id, s.stop_name,
                s.stop_lat AS lat, s.stop_lon AS lon
            FROM gtfs_metro.trips t
            JOIN gtfs_metro.stop_times st ON st.trip_id = t.trip_id
            JOIN gtfs_metro.stops s       ON s.stop_id  = st.stop_id
            WHERE t.route_id = :rid
            ORDER BY st.stop_sequence ASC
            LIMIT 200
        """, {"rid": route_id})

    shapes = _q(
        "SELECT ST_AsGeoJSON(geom)::json AS geometry "
        "FROM derived.route_geometries WHERE route_id = :rid LIMIT 1",
        {"rid": route_id},
    )
    return {
        "route": routes[0],
        "stop_count": len(stops),
        "stops": stops,
        "shape_ref": _stash_geometry(shapes[0]["geometry"]) if shapes else None,
    }


def compare_transit_access(area_a: str, area_b: str) -> dict:
    """Side-by-side transit metrics for two Delhi wards (query #2).

    Args:
        area_a: Ward name (case-insensitive) or ward_id.
        area_b: Ward name or ward_id to compare against.

    Returns:
        Metrics for both wards including RS indices when available. Each
        side's ward geometry goes to the map via its own geometry_ref
        (the caller highlights both — query #2 in CLAUDE.md §7 is a
        comparison result *and* a choropleth of the two wards), not inline.
    """
    sql = """
        SELECT wm.ward_id, wm.ward_name, bus_stop_count, metro_stop_count,
               peak_freq_mean, offpeak_freq_mean,
               has_metro_within_1k, multimodal_gap_count,
               transit_score, pop_total, stops_per_10k,
               ndvi_mean, ndbi_mean, urban_stress_index,
               ST_AsGeoJSON(_simplify_round(w.geometry), 5)::json AS geometry
        FROM derived.ward_metrics wm
        JOIN public.wards w USING (ward_id)
        WHERE wm.ward_id = ANY(:ids)
        ORDER BY wm.ward_name
    """

    def _fetch(name: str) -> dict:
        ward_ids, method = _match_ward_ids(name)
        if not ward_ids:
            return {"error": f"No wards found matching '{name}'. Try a different spelling."}
        rows = _q(sql, {"ids": ward_ids})
        if len(rows) == 1:
            r = rows[0]
            geometry = r.pop("geometry", None)
            out = {k: (round(float(v), 4) if isinstance(v, (float, __import__("decimal").Decimal)) else v)
                   for k, v in r.items()}
            out["geometry_ref"] = _stash_geometry(geometry)
            if method == "fuzzy":
                out["note"] = f"'{name}' fuzzy-matched to {r['ward_name']} (trigram similarity)."
            return out
        # Multiple wards matched (e.g. DWARKA SECTOR 1..20) — aggregate
        import statistics
        def _avg(k):
            v = [r[k] for r in rows if r[k] is not None]
            return round(statistics.mean(v), 4) if v else None
        def _sum(k):
            v = [r[k] for r in rows if r[k] is not None]
            return sum(v) if v else None
        names = [r["ward_name"] for r in rows]
        fc = {
            "type": "FeatureCollection",
            "features": [
                {"type": "Feature", "geometry": r["geometry"], "properties": {"ward_name": r["ward_name"]}}
                for r in rows if r.get("geometry")
            ],
        }
        return {
            "area_name":            name,
            "wards_matched":        len(rows),
            "matched_wards":        names,
            "bus_stop_count":       _sum("bus_stop_count"),
            "metro_stop_count":     _sum("metro_stop_count"),
            "peak_freq_mean":       _avg("peak_freq_mean"),
            "has_metro_within_1k":  any(r["has_metro_within_1k"] for r in rows),
            "multimodal_gap_count": _sum("multimodal_gap_count"),
            "transit_score":        _avg("transit_score"),
            "pop_total":            _sum("pop_total"),
            "stops_per_10k":        _avg("stops_per_10k"),
            "ndvi_mean":            _avg("ndvi_mean"),
            "ndbi_mean":            _avg("ndbi_mean"),
            "urban_stress_index":   _avg("urban_stress_index"),
            "geometry_ref": _stash_geometry(fc),
            "note": f"Aggregated across {len(rows)} wards"
                    + (" (fuzzy name match)" if method == "fuzzy" else "") + ": "
                    + ", ".join(names[:5]) + (" ..." if len(names) > 5 else ""),
        }

    return {area_a: _fetch(area_a), area_b: _fetch(area_b)}


def _dual_catchment(lon: float, lat: float, bus_radius_m: int, metro_radius_m: int) -> dict:
    """Two fn_catchment calls at the standard PT walk-access benchmarks
    (500m bus / 800m metro, same defaults as get_pop_walk_access) around one
    point, returned as a combined inner/outer pair rather than one radius.
    The formatter draws both rings in a single buffer map_layer — same
    fillToken, so the 0-500m disc reads visibly denser than the 500-800m
    annulus purely from the two semi-transparent fills overlapping there,
    with no per-feature styling needed."""
    inner = _q(
        "SELECT * FROM fn_catchment(:lon, :lat, :r)",
        {"lon": lon, "lat": lat, "r": bus_radius_m},
    )[0]
    outer = _q(
        "SELECT * FROM fn_catchment(:lon, :lat, :r)",
        {"lon": lon, "lat": lat, "r": metro_radius_m},
    )[0]
    return {
        "radius_m_inner": bus_radius_m,
        "radius_m_outer": metro_radius_m,
        "buffer_ref_inner": _stash_geometry(inner["buffer_geojson"]),
        "buffer_ref_outer": _stash_geometry(outer["buffer_geojson"]),
        "bus_stops_in_catchment_inner": inner["bus_stops_in_catchment"],
        "bus_boarding_points_in_catchment_inner": inner.get("bus_boarding_points_in_catchment"),
        "metro_stops_in_catchment_inner": inner["metro_stops_in_catchment"],
        "estimated_population_covered_inner": inner["estimated_population_covered"],
        "intersecting_ward_count_inner": inner["intersecting_ward_count"],
        "bus_stops_in_catchment_outer": outer["bus_stops_in_catchment"],
        "bus_boarding_points_in_catchment_outer": outer.get("bus_boarding_points_in_catchment"),
        "metro_stops_in_catchment_outer": outer["metro_stops_in_catchment"],
        "estimated_population_covered_outer": outer["estimated_population_covered"],
        "intersecting_ward_count_outer": outer["intersecting_ward_count"],
    }


def get_metro_catchment(station_name: str, bus_radius_m: int = 500, metro_radius_m: int = 800) -> dict:
    """Return the combined 500m + 800m catchment around a metro station (query #3).

    Args:
        station_name: Station name (partial match supported).
        bus_radius_m: Inner ring radius in metres — the standard walk to a
            bus stop (default 500).
        metro_radius_m: Outer ring radius in metres — the standard walk to a
            metro station (default 800). Both rings are always shown
            together, not one or the other.

    Returns:
        Station info + both rings' buffer geometry, stop counts, and
        WorldPop-derived population estimate.
    """
    stations = _q(
        "SELECT stop_id, stop_name, stop_lat AS lat, stop_lon AS lon "
        "FROM gtfs_metro.stops WHERE stop_name ILIKE :pat ORDER BY stop_name LIMIT 5",
        {"pat": f"%{station_name}%"},
    )
    if not stations:
        return {"error": f"No metro station matching '{station_name}'"}
    s = stations[0]
    return {"station": s, **_dual_catchment(s["lon"], s["lat"], bus_radius_m, metro_radius_m)}


SCENARIO_METHOD = (
    "WorldPop 2020 100 m cells; straight-line distance in EPSG:32643; a cell is served when a bus stop "
    "is within the bus radius or a metro station within the metro radius (or the single mode chosen)"
)
_LAT_RANGE, _LON_RANGE = (28.3, 29.0), (76.7, 77.6)


def _parse_lonlat(text: str) -> tuple[float, float] | None:
    """'lon,lat' or 'lat,lon' (either order) inside the Delhi bounding box."""
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*", text or "")
    if not m:
        return None
    a, b = float(m.group(1)), float(m.group(2))
    for lon, lat in ((a, b), (b, a)):
        if _LON_RANGE[0] <= lon <= _LON_RANGE[1] and _LAT_RANGE[0] <= lat <= _LAT_RANGE[1]:
            return lon, lat
    return None


def _resolve_site(text: str) -> dict:
    """A site for a new stop: coordinates, or a ward/neighbourhood name resolved to a
    point inside the ward (same matching as geocode_neighbourhood)."""
    ll = _parse_lonlat(text)
    if ll:
        return {"label": text.strip(), "lon": ll[0], "lat": ll[1]}
    if re.fullmatch(r"\s*-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?\s*", text or ""):
        return {"error": f"'{text}' is outside Delhi"}
    ward_ids, _ = _match_ward_ids(text)
    if not ward_ids:
        return {"error": f"No ward or place found matching '{text}'. Give coordinates as 'lon,lat' instead."}
    row = _q("""
        SELECT ward_name, ST_X(ST_PointOnSurface(geometry)) AS lon, ST_Y(ST_PointOnSurface(geometry)) AS lat
        FROM public.wards WHERE ward_id = ANY(:ids) ORDER BY array_position(:ids, ward_id) LIMIT 1
    """, {"ids": ward_ids})[0]
    return {"label": row["ward_name"].title(), "lon": round(row["lon"], 6), "lat": round(row["lat"], 6)}


def _resolve_closure(text: str) -> dict:
    """An existing transit point to remove, by point_id or by stop/station name."""
    rows = _q(
        "SELECT point_id, name, mode, trips_day FROM derived.transit_points "
        "WHERE point_id = :t OR name ILIKE :pat ORDER BY (name ILIKE :t) DESC, mode = 'metro' DESC, trips_day DESC LIMIT 6",
        {"t": text.strip(), "pat": f"%{text.strip()}%"},
    )
    if not rows:
        return {"error": f"No stop or station matching '{text}'"}
    exact = [r for r in rows if r["name"].lower() == text.strip().lower() or r["point_id"] == text.strip()]
    pick = exact if len(exact) == 1 else (rows if len(rows) == 1 else None)
    if pick is None:
        return {"error": f"'{text}' matches several stops: "
                         + "; ".join(f"{r['name']} ({r['mode']}, {r['trips_day']} trips/day) id={r['point_id']}" for r in rows[:5])
                         + ". Ask the user which one, or pass its id."}
    return pick[0]


def simulate_network_change(
    add_at: list[str] | None = None,
    add_mode: str = "metro",
    remove: list[str] | None = None,
    measure: str = "any",
    bus_radius_m: int = 500,
    metro_radius_m: int = 800,
) -> dict:
    """WHAT-IF on the stop network: add new stops/stations and/or close existing
    ones, then report how many people gain or lose walking access. Use for "if a
    metro station is added at X, how many more people fall within 800m", "what if
    we close Kashmere Gate", "add two bus stops in Seemapuri", "what happens if
    these stops are removed", any hypothetical change to the stops.

    Args:
        add_at: New stop sites. Each item is a ward/neighbourhood name (e.g.
            "Sangam Vihar") OR coordinates "lon,lat" (e.g. "77.2375,28.5033").
            Up to 10. Leave empty if only removing.
        add_mode: Mode of every added stop: 'metro' (800 m walk) or 'bus' (500 m).
        remove: Existing stops/stations to close, by name (e.g. "Kashmere Gate")
            or point_id. Up to 25. Leave empty if only adding.
        measure: Which access to count: 'any' (bus OR metro - default), 'metro'
            (metro access only - use for "close a metro station" so people still
            reached by bus are not hidden), or 'bus'.
        bus_radius_m: Walk radius to a bus stop in metres (default 500).
        metro_radius_m: Walk radius to a metro station in metres (default 800).

    Returns:
        people_newly_covered, people_losing_coverage, net_change,
        people_within_new_stops, unserved_share_before_pct and
        unserved_share_after_pct (population beyond walking distance), the
        resolved added/removed sites, and a method line. Report only these numbers.
    """
    adds, notes = [], []
    for text in add_at or []:
        site = _resolve_site(text)
        if "error" in site:
            return site
        adds.append(site)
    closures = []
    for text in remove or []:
        pt = _resolve_closure(text)
        if "error" in pt:
            return pt
        closures.append(pt)
    if not adds and not closures:
        return {"error": "Give at least one stop to add (add_at) or remove."}

    r = _q(
        "SELECT fn_network_scenario(CAST(:lons AS float8[]), CAST(:lats AS float8[]), :mode, "
        "CAST(:rm AS text[]), :b, :m, :ev) AS r",
        {"lons": [a["lon"] for a in adds], "lats": [a["lat"] for a in adds], "mode": add_mode,
         "rm": [c["point_id"] for c in closures], "b": bus_radius_m, "m": metro_radius_m, "ev": measure},
    )[0]["r"]
    buffer = r.pop("added_buffer", None)
    return {
        **r,
        "added": adds,
        "removed": closures,
        "buffer_ref": _stash_geometry(buffer) if buffer else None,
        "method": SCENARIO_METHOD,
    }


def get_frequency_at_stop(
    stop_id: str,
    start_time: str = "08:00:00",
    end_time: str = "10:00:00",
) -> dict:
    """Return service frequency at a stop during a time window.

    Args:
        stop_id: GTFS stop_id e.g. 'bus_1234' or 'metro_45'.
        start_time: Window start HH:MM:SS (24h, may exceed 24:00).
        end_time: Window end HH:MM:SS.

    Returns:
        trip_count, trips_per_hour, and (metro only) first/last arrivals.

    Note: bus frequency comes from derived.stop_hourly_frequency (hourly
    buckets, precomputed locally) rather than a live gtfs_bus.stop_times
    join — that raw table is deliberately absent from schema.sql. This means
    bus results are bucketed to the hour, not the exact second window; metro
    still queries its raw stop_times for an exact window.
    """
    schema = "gtfs_metro" if stop_id.startswith("metro_") else "gtfs_bus"
    info = _q(
        f"SELECT stop_id, stop_name, stop_lat AS lat, stop_lon AS lon "
        f"FROM {schema}.stops WHERE stop_id = :sid",
        {"sid": stop_id},
    )
    if not info:
        return {"error": f"Stop '{stop_id}' not found"}

    def _hour(t: str) -> int:
        return int(t.split(":")[0])

    wh = (_hour(end_time) - _hour(start_time)) if _hour(end_time) > _hour(start_time) else 1

    if schema == "gtfs_bus":
        hours = list(range(_hour(start_time), _hour(end_time)))
        freq = _q("""
            SELECT COALESCE(SUM(trip_count), 0) AS trip_count
            FROM derived.stop_hourly_frequency
            WHERE stop_id = :sid AND feed = 'bus' AND hour_of_day = ANY(:hours)
        """, {"sid": stop_id, "hours": hours})
        tc = freq[0]["trip_count"] if freq else 0
        return {
            "stop": info[0],
            "window": {"start": start_time, "end": end_time, "hours": wh},
            "trip_count": tc,
            "trips_per_hour": round(tc / wh, 2) if wh > 0 else 0,
            "note": "Bus frequency bucketed to the hour (derived.stop_hourly_frequency), not exact-second window.",
        }

    def _s(t: str) -> int:
        h, m, s = t.split(":")
        return int(h) * 3600 + int(m) * 60 + int(s)

    freq = _q(f"""
        SELECT COUNT(DISTINCT trip_id) AS trip_count,
               MIN(arrival_time) AS first_arrival, MAX(arrival_time) AS last_arrival
        FROM {schema}.stop_times
        WHERE stop_id = :sid AND arrival_seconds >= :s0 AND arrival_seconds < :s1
    """, {"sid": stop_id, "s0": _s(start_time), "s1": _s(end_time)})

    tc = freq[0]["trip_count"] if freq else 0
    wh_exact = (_s(end_time) - _s(start_time)) / 3600
    return {
        "stop": info[0],
        "window": {"start": start_time, "end": end_time, "hours": wh_exact},
        "trip_count": tc,
        "trips_per_hour": round(tc / wh_exact, 2) if wh_exact > 0 else 0,
        "first_arrival": freq[0]["first_arrival"] if freq else None,
        "last_arrival":  freq[0]["last_arrival"]  if freq else None,
    }


def find_multimodal_gaps(max_distance_m: int = 1000, top_n: int = 20) -> dict:
    """Find bus stops with no metro within max_distance_m metres.

    Args:
        max_distance_m: Gap threshold in metres (default 1000).
        top_n: Number of results to return.

    Returns:
        Bus stops that lack metro access, sorted by distance to nearest metro.
    """
    rows = _q("""
        WITH nearest AS (
            SELECT b.stop_id, b.stop_name,
                   b.stop_lat AS lat, b.stop_lon AS lon,
                   (SELECT ROUND(ST_Distance(b.geom::geography, m.geom::geography))::int
                    FROM gtfs_metro.stops m
                    ORDER BY b.geom::geography <-> m.geom::geography
                    LIMIT 1) AS dist_to_metro_m
            FROM gtfs_bus.stops b
        )
        SELECT n.stop_id, n.stop_name, n.lat, n.lon,
               n.dist_to_metro_m, w.ward_name
        FROM nearest n
        LEFT JOIN public.wards w ON ST_Within(
            ST_SetSRID(ST_MakePoint(n.lon, n.lat), 4326), w.geometry
        )
        WHERE n.dist_to_metro_m > :d
        ORDER BY n.dist_to_metro_m DESC
        LIMIT :n
    """, {"d": max_distance_m, "n": top_n})
    return {"max_distance_m": max_distance_m, "count": len(rows), "stops": rows}


def get_ward_rs_profile(ward_name: str) -> dict:
    """Full remote sensing and transit profile for a Delhi ward.

    Args:
        ward_name: Ward name (case-insensitive, partial match) or ward_id.

    Returns:
        Transit score, population, stops/10k, NDVI, NDBI, urban stress index.
    """
    ward_ids, method = _match_ward_ids(ward_name)
    if not ward_ids:
        return {"error": f"No ward found matching '{ward_name}'"}
    rows = _q("""
        SELECT wm.ward_id, wm.ward_name,
               wm.bus_stop_count, wm.metro_stop_count,
               ROUND(wm.peak_freq_mean::numeric, 2)     AS peak_freq_mean,
               wm.has_metro_within_1k, wm.multimodal_gap_count,
               ROUND(wm.transit_score::numeric, 4)      AS transit_score,
               wm.pop_total,
               ROUND(wm.stops_per_10k::numeric, 4)      AS stops_per_10k,
               ROUND(wm.ndvi_mean::numeric, 4)          AS ndvi_mean,
               ROUND(wm.ndbi_mean::numeric, 4)          AS ndbi_mean,
               ROUND(wm.urban_stress_index::numeric, 4) AS urban_stress_index,
               ST_AsGeoJSON(w.geometry)::json           AS geometry
        FROM derived.ward_metrics wm
        JOIN public.wards w ON w.ward_id = wm.ward_id
        WHERE wm.ward_id = ANY(:ids)
        ORDER BY array_position(:ids, wm.ward_id) LIMIT 3
    """, {"ids": ward_ids})
    out = {"matches": len(rows), "wards": rows}
    if method == "fuzzy":
        out["note"] = (f"No exact match for '{ward_name}' — closest ward names "
                       "by trigram similarity; confirm with the user if ambiguous.")
    elif len(rows) > 1:
        out["note"] = (f"'{ward_name}' matched {len(rows)} wards — profiles are "
                        "per ward, not aggregated; confirm which one the user "
                        "means before treating this as a single ward.")
    return out


def get_urban_stress_map() -> dict:
    """GeoJSON FeatureCollection of all wards for choropleth rendering.

    Properties include transit_score, urban_stress_index, NDVI, NDBI,
    population, and stops_per_10k for every ward. Geometry is simplified
    and 5-decimal rounded server-side (fn_ward_choropleth) to stay under
    the 1MB payload budget.

    Returns:
        Ward count + geometry_ref for the FeatureCollection (the map gets the
        polygons via the formatter; the LLM only needs to know it exists).
    """
    rows = _q("SELECT * FROM fn_ward_choropleth()")
    features = [
        {"type": "Feature",
         "geometry": r.pop("geometry", None),
         "properties": dict(r)}
        for r in rows
    ]
    fc = {"type": "FeatureCollection", "features": features}
    return {"ward_count": len(features), "geometry_ref": _stash_geometry(fc)}


def semantic_stop_search(query_text: str, top_n: int = 10) -> dict:
    """Search stops by name using fuzzy matching.

    Tries pgvector cosine similarity if embeddings exist, falls back to
    pg_trgm trigram similarity for common Delhi place-name variants.

    Args:
        query_text: Place name or neighbourhood to search for.
        top_n: Number of results (default 10).

    Returns:
        Matching stops with similarity scores and method used.
    """
    try:
        rows = _q("""
            SELECT stop_id, stop_name, feed,
                   1 - (embedding <=> (
                       SELECT embedding FROM embeddings.stop_embeddings
                       WHERE stop_name ILIKE :q LIMIT 1
                   )) AS similarity
            FROM embeddings.stop_embeddings
            ORDER BY similarity DESC LIMIT :n
        """, {"q": f"%{query_text}%", "n": top_n})
        if rows:
            return {"method": "pgvector", "results": rows}
    except Exception:
        pass

    rows = _q("""
        SELECT stop_id, stop_name, feed,
               stop_lat AS lat, stop_lon AS lon,
               ROUND(similarity(stop_name, :q)::numeric, 3) AS similarity
        FROM (
            SELECT stop_id, stop_name, 'bus'   AS feed, stop_lat, stop_lon FROM gtfs_bus.stops
            UNION ALL
            SELECT stop_id, stop_name, 'metro' AS feed, stop_lat, stop_lon FROM gtfs_metro.stops
        ) all_stops
        WHERE stop_name ILIKE :pat OR similarity(stop_name, :q) > 0.2
        ORDER BY similarity DESC LIMIT :n
    """, {"q": query_text, "pat": f"%{query_text}%", "n": top_n})
    return {"method": "trigram", "results": rows}


# ---------------------------------------------------------------------------
# RATE LIMIT DETECTION
# ---------------------------------------------------------------------------

def _is_rate_limit(exc: Exception) -> bool:
    try:
        from google.api_core.exceptions import ResourceExhausted, TooManyRequests, ServiceUnavailable
        if isinstance(exc, (ResourceExhausted, TooManyRequests, ServiceUnavailable)):
            return True
    except ImportError:
        pass

    msg = str(exc).lower()
    return any(
        k in msg
        for k in (
            "resource exhausted", "429", "quota", "rate limit",
            "503", "unavailable", "overloaded", "high demand",
        )
    )

def _is_not_found(e: Exception) -> bool:
    return "not found" in str(e).lower()

def _is_quota(e: Exception) -> bool:
    return "quota" in str(e).lower() or "429" in str(e)

# ---------------------------------------------------------------------------
# Agent + Runner
# ---------------------------------------------------------------------------

TOOLS = [
    get_nearby_stops,
    reverse_geocode,
    find_underserved_areas,
    get_ward_density_ranking,
    get_pop_walk_access,
    coverage_gap,
    stop_heat_exposure,
    get_route_coverage,
    compare_transit_access,
    get_metro_catchment,
    simulate_network_change,
    get_frequency_at_stop,
    find_multimodal_gaps,
    get_ward_rs_profile,
    geocode_neighbourhood,
    geocode_location,
    get_urban_stress_map,
    semantic_stop_search,
]

# Slim tool set for the open-source tier: Groq's free tier caps a single
# request at 8k tokens, and the full 15-tool schema alone is well over that.
# These eight cover all 5 headline queries plus ward lookup and both
# geocoding directions — anything needing the rest classifies as advanced
# and runs on Gemini anyway. geocode_location (external API, higher latency)
# stays advanced-tier only — it's an edge-case fallback, not a headline query.
SIMPLE_TOOLS = [
    find_underserved_areas,
    get_ward_density_ranking,
    get_pop_walk_access,
    coverage_gap,
    stop_heat_exposure,
    compare_transit_access,
    get_metro_catchment,
    simulate_network_change,
    get_ward_rs_profile,
    reverse_geocode,
    geocode_neighbourhood,
]

SIMPLE_SYSTEM_PROMPT = """You are the City Transit Intelligence Agent (Propus).
Answer the user's question with ONE tool call, then summarise the result in
2-3 sentences. Never invent numbers — report only what tools return.

GLOSSARY: "PT" = public transit/transport (bus + metro). "Walk access" /
"walkable" / "on foot" / "within walking distance" all mean the same thing.

Data: 6,880 bus stops (distinct boarding points — never say 10,559, that's raw
feed rows), 262 metro stops, 11 metro lines, 290 MCD wards with computed
transit metrics. Don't state a specific "number of bus routes" — the feed has
no dedup key for routes, unlike stops. Ward names in the DB are ALL-CAPS official
MCD names; tools handle partial (LIKE) and fuzzy (trigram) matching, so pass
names as given — misspellings resolve. If a result notes a fuzzy match, say
which ward name was matched.
"Dwarka" does NOT exist in this dataset (sub-city, not an MCD ward) — say so
if asked; "Seemapuri" resolves to the ward NEW SEEMA PURI.

Routing:
- worst / underserved wards          → find_underserved_areas
- BEST transit access / best served  → get_ward_density_ranking(metric='transit_score')
- top N wards by stop density/count  → get_ward_density_ranking(metric='bus_stop_count')
- % / how much / how many people have PT access by walk / on foot / within
  walking distance, CITY-WIDE → get_pop_walk_access (defaults 500m to a bus
  stop, 800m to a metro station; override if the user names a distance).
  Not the same as catchment around one station — that's get_metro_catchment.
- people living MORE THAN X m from transit / far from transit / biggest
  coverage gaps / areas with no metro within 1 km → coverage_gap (mode='any',
  'bus' or 'metro'; e.g. metro_radius_m=1000, mode='metro')
- hot stops / busiest stops on the hottest surfaces / share of trips at hot
  stops → stop_heat_exposure (leave threshold_c unset unless a number is
  given; it is land SURFACE temperature, not air temperature)
- air quality / ridership / income / felt heat → no tool; say you lack that data
- compare ward A vs ward B           → compare_transit_access
- catchment around a metro station   → get_metro_catchment (combined 500m + 800m rings)
- new-stop scenario at a lon/lat     → simulate_network_change (add_at=["lon,lat"])
- "tell me about [area]"             → get_ward_rs_profile
- "what area is at lat/lon?"         → reverse_geocode
- "where is [area]? / coordinates"   → geocode_neighbourhood

Rules: every number must come from a tool result - never estimate or use outside
knowledge. Heat is land SURFACE temperature (relative), not air temperature.
If no tool has the data (air quality, ridership, income, felt heat), call NO tool
and say in one plain sentence that Propus does not have that data.
"""


def _make_litellm_model(model: str):
    from google.adk.models.lite_llm import LiteLlm, LiteLLMClient

    class _StripReasoningClient(LiteLLMClient):
        """Groq's API rejects 'reasoning_content' when a reasoning model's
        (gpt-oss, qwen3) assistant turns are echoed back as history — strip
        it from outgoing messages; it's never needed server-side."""

        async def acompletion(self, model, messages, tools, **kwargs):
            for m in messages:
                if isinstance(m, dict):
                    m.pop("reasoning_content", None)
            return await super().acompletion(
                model=model, messages=messages, tools=tools, **kwargs
            )

    # Groq's completion call: observed hanging with literally zero response
    # (no HTTP error, no exception) until the outer 25s agent-turn timeout
    # cancelled it — indistinguishable in the logs from any other kind of
    # stall. `timeout` is forwarded verbatim to litellm.acompletion() (ADK's
    # LiteLlm stores **kwargs into _additional_args and merges them into the
    # call), so a stuck request now fails with a specific, attributable
    # litellm.Timeout instead of a generic cancellation.
    return LiteLlm(model=model, llm_client=_StripReasoningClient(), timeout=GROQ_TIMEOUT_SECONDS)


def create_agent(model: str, tier: str = "advanced"):
    from google.adk.agents import Agent

    # "provider/model" names (e.g. groq/openai/gpt-oss-120b) route through
    # LiteLLM; bare names are native Gemini.
    adk_model = _make_litellm_model(model) if "/" in model else model
    slim = tier == "simple"

    agent = Agent(
        name="delhi_transit_agent",
        model=adk_model,
        description="Delhi transit equity intelligence — real GTFS + PostGIS data",
        instruction=SIMPLE_SYSTEM_PROMPT if slim else SYSTEM_PROMPT,
        tools=SIMPLE_TOOLS if slim else TOOLS,
    )
    log.info("Agent ready — model=%s tier=%s", model, tier)
    return agent


def create_runner(model: str = None, tier: str = "advanced"):
    from google.adk.runners import Runner

    if model is None:
        model = pick_model(tier)

    return Runner(
        agent=create_agent(model, tier),
        app_name="propus_transit",
        session_service=_session_service,
    )

# ---------------------------------------------------------------------------
# QUERY EXECUTION (WITH TIMEOUT) — streaming variant used by apps/api/main.py
# ---------------------------------------------------------------------------

async def run_query_events(query: str, session_id: str, user_id: str, runner):
    """Yield raw ADK events for a query — apps/api/main.py maps these to
    typed PropusEvent (reasoning_step / result / done).

    Unlike the sibling `run_query()` below (which wraps the same kind of
    call in `asyncio.wait_for(..., timeout=TIMEOUT_SECONDS)`), this
    streaming variant — the one actually wired into the live /query/stream
    endpoint — had no timeout at all. Observed in prod: the stream emits
    one "Analysing your question..." step and then goes completely silent
    (no further reasoning steps, no result, no error) for 90+ seconds,
    because a stuck `runner.run_async()` (a slow/hung LLM provider call)
    just sits there forever with nothing to bound it — the front-end only
    ever finds out via its own SSE read eventually giving up. `asyncio.timeout`
    turns that into a real, prompt `Exception` that `_stream_query`'s
    handler (apps/api/main.py) already knows how to turn into an honest
    ErrorEvent.

    This does NOT cover every possible hang: a purely synchronous blocking
    call somewhere in the tool chain (e.g. `_q()`'s psycopg2 connect, before
    the `connect_args={"connect_timeout": ...}` fix above) freezes the event
    loop itself, and asyncio's own cancellation can't preempt that — it can
    only fire once the loop is free to run it. The DB connect_timeout above
    is what actually bounds that specific case.
    """
    from google.genai import types

    try:
        await _session_service.create_session(
            app_name="propus_transit",
            user_id=user_id,
            session_id=session_id,
        )
    except Exception:
        pass

    content = types.Content(role="user", parts=[types.Part(text=query)])

    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session_id,
                new_message=content,
            ):
                yield event
    except TimeoutError:
        raise Exception(f"Agent turn exceeded {TIMEOUT_SECONDS}s timeout")


async def _run_query_inner(query: str, session_id: str, user_id: str, runner):
    from google.genai import types

    try:
        await _session_service.create_session(
            app_name="propus_transit",
            user_id=user_id,
            session_id=session_id,
        )
    except Exception:
        pass

    content = types.Content(role="user", parts=[types.Part(text=query)])

    async for event in runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=content,
    ):
        if event.is_final_response():
            if event.content and event.content.parts:
                return event.content.parts[0].text

    return ""

async def run_query(query: str, session_id="default", user_id="user", runner=None):
    if runner is None:
        runner = create_runner(MODEL_CHAIN[0])

    try:
        return await asyncio.wait_for(
            _run_query_inner(query, session_id, user_id, runner),
            timeout=TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        raise Exception("LLM request timeout")

# ---------------------------------------------------------------------------
# FALLBACK LOGIC
# ---------------------------------------------------------------------------

async def run_with_fallback(query: str, session_id="default", user_id="user"):
    global _current_model_idx

    for model_idx in range(_current_model_idx, len(MODEL_CHAIN)):
        model = MODEL_CHAIN[model_idx]
        runner = create_runner(model)

        for attempt in range(3):
            try:
                result = await run_query(query, session_id, user_id, runner)

                # Reset failure count on success
                _model_failures[model] = 0

                # Reset to best model if recovered
                if _current_model_idx > 0:
                    log.info("Recovered on %s → resetting to primary model", model)
                    _current_model_idx = 0

                return result

            except Exception as exc:
                if _is_rate_limit(exc):
                    _model_failures[model] += 1

                    wait = min(BASE_DELAY * (2 ** attempt), MAX_DELAY)
                    wait += random.uniform(0, 1)

                    log.warning(
                        "Rate limit on %s (attempt %d) → waiting %.2fs",
                        model, attempt + 1, wait,
                    )

                    await asyncio.sleep(wait)

                    if _model_failures[model] >= FAILURE_THRESHOLD:
                        log.warning("Switching model due to repeated failures: %s", model)
                        _current_model_idx = min(model_idx + 1, len(MODEL_CHAIN) - 1)
                        break

                else:
                    raise
        log.info("Using model: %s", model)
    return "All models are currently rate-limited. Please try again later."

# ---------------------------------------------------------------------------
# Interactive terminal
# ---------------------------------------------------------------------------

async def _interactive_session():
    from google.genai import types

    print("\n" + "=" * 60)
    print("  Propus — City Transit Intelligence Agent")
    print("  Type 'exit' to quit")
    print("=" * 60)
    print("\nTry:")
    print("  Which wards have the worst transit access?")
    print("  Find stops near Connaught Place (lat 28.6315, lon 77.2167)")
    print("  Compare Vasant Vihar and Vasantkunj")
    print("  Which bus stops are farthest from any metro?\n")

    runner = create_runner()
    sid, uid = "terminal", "terminal_user"
    await runner.session_service.create_session(
        app_name="propus_transit", user_id=uid, session_id=sid,
    )

    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye.")
            break
        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "q"}:
            print("Goodbye.")
            break

        content = types.Content(role="user", parts=[types.Part(text=user_input)])
        print("Agent: ", end="", flush=True)

        async for event in runner.run_async(user_id=uid, session_id=sid, new_message=content):
            if event.is_final_response():
                if event.content and event.content.parts:
                    print(event.content.parts[0].text)
            elif hasattr(event, "tool_call") and event.tool_call:
                print(f"\n  [→ {getattr(event.tool_call, 'name', 'tool')}]",
                      end="", flush=True)
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", "-q", default=None)
    args = parser.parse_args()

    if args.query:
        async def _single():
            print(f"\nAgent: {await run_query(args.query)}\n")
        asyncio.run(_single())
    else:
        asyncio.run(_interactive_session())

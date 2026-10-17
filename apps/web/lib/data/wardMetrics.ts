/**
 * REAL ward metrics — regenerated from the live derived.ward_metrics table
 * (Supabase, AGENT_DATABASE_URL) on 2026-09-07. Evidence class: Calculated.
 * Do NOT edit values here; regenerate from the live DB and update the
 * provenance date.
 *
 * Coverage facts from the same query:
 *   - 290/290 wards have bus_stop_count + transit_score
 *   - 23 wards have zero bus stops
 *   - 267/290 wards have peak-frequency values
 *
 * 2026-09-07 re-generation note: transit_score changed for every ward with
 * any stops. `area_sq_km`/`stop_density_per_km2` were declared in
 * db/schema.sql and pipeline/compute.py but had never actually been added to
 * the live table — transit_score was silently running an older, pre-density
 * formula (raw stop count, not stops/km²) the whole time. Fixed live; this
 * fixture is regenerated from the corrected values. WORST_WARDS is unchanged
 * (0 stops ÷ any area is still 0), BEST_WARDS reordered and rescored.
 */

export const PROVENANCE = {
  source: "derived.ward_metrics — live query 2026-09-07",
  attribution: [
    "© Open Transit Data, Government of Delhi (bus GTFS)",
    "© Delhi Metro Rail Corporation via OTD (metro GTFS)",
    "© OpenCity (ward boundaries)",
  ],
  crs: "Computed in EPSG:32643 (UTM 43N); displayed in EPSG:4326",
} as const;

export interface WardMetric {
  ward: string;
  stops: number;
  freqPerHr: number | null; // null = no bus stops, frequency undefined
  metro: boolean;
  score: number;
}

/** Transit score — 10 worst-served wards (real). */
export const WORST_WARDS: WardMetric[] = [
  { ward: "SANGAM VIHAR", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "TIGRI", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "RAJ NAGAR", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "PREM NAGAR", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "SAGARPUR", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "SAID UL AJAIB", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "SANGAM VIHAR CENTRAL", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "SANGAM VIHAR WEST", stops: 0, freqPerHr: null, metro: false, score: 0.0 },
  { ward: "JAITPUR", stops: 1, freqPerHr: 0.67, metro: false, score: 0.0046 },
  { ward: "MEETHEYPUR", stops: 2, freqPerHr: 1.0, metro: false, score: 0.0082 },
];

/** Transit score — 10 best-served wards (real, post density-fix). */
export const BEST_WARDS: WardMetric[] = [
  { ward: "KASHMERE GATE", stops: 110, freqPerHr: 35.46, metro: true, score: 0.7768 },
  { ward: "MINTO ROAD", stops: 89, freqPerHr: 38.8, metro: true, score: 0.749 },
  { ward: "NDMC CHARGE 4", stops: 150, freqPerHr: 30.72, metro: true, score: 0.7242 },
  { ward: "MODEL BASTI", stops: 43, freqPerHr: 42.02, metro: true, score: 0.6679 },
  { ward: "NDMC CHARGE 1", stops: 110, freqPerHr: 30.11, metro: true, score: 0.6668 },
  // NAJAFGARH scores high because a real bus terminal sits inside this
  // small ward polygon — genuine access at that node, not necessarily
  // representative of the wider, more peripheral area the name colloquially
  // refers to (Peeragarhi, just outside this top 10, is the same story —
  // see FIND_UNDERSERVED_METHODOLOGY caveats).
  { ward: "NAJAFGARH", stops: 61, freqPerHr: 35.05, metro: true, score: 0.661 },
  { ward: "SARAI PIPAL THALA", stops: 40, freqPerHr: 55.47, metro: true, score: 0.6513 },
  { ward: "MANGOLPURI  EAST", stops: 30, freqPerHr: 27.56, metro: true, score: 0.6463 },
  { ward: "KAROL BAGH", stops: 62, freqPerHr: 40.99, metro: true, score: 0.6301 },
  // R. K. PURAM and KAROL BAGH are effectively tied (0.6300 vs 0.6301).
  { ward: "R. K. PURAM", stops: 76, freqPerHr: 27.94, metro: true, score: 0.63 },
];
// Note: the live table also lists `ward_fallback_000`, now named "YAMUNA
// FLOODPLAIN (ZONE O)" (96 stops, metro, transit_score 0.581 post-fix) — a
// geometry likely representing the Yamuna river corridor rather than a real
// residential ward (see pipeline/ingest.py). Excluded from this demo list:
// naming it doesn't resolve whether it should count as a ward at all, and a
// river-adjacent artifact isn't representative of what this list is for.

/** Network-wide verified totals (ARCHITECTURE.md + day2_summary.md, all real).
 *
 *  "How many bus stops" has three real answers and they differ by 2.4x, so the
 *  unit is named rather than implied (see pipeline/cluster_stops.py):
 *
 *    busStopRows          10,559  raw GTFS rows — one per (pole x route)
 *    busBoardingPoints     6,880  distinct stop_code, one per pole   [Observed]
 *    busPhysicalStops      4,388  clustered locations @40m           [Estimated]
 *
 *  Public-facing copy uses busBoardingPoints: it is the largest figure that is
 *  still a count of real, distinct physical objects, and it is Observed rather
 *  than inferred. busStopRows is NOT a stop count and must never be labelled
 *  as one — it counts records, and the same pole appears in it once per route.
 */
export const NETWORK_TOTALS = {
  busStopRows: 10559,
  busBoardingPoints: 6880,
  busPhysicalStops: 4388,
  // "How many bus routes" has the exact same rows-vs-real-thing problem as
  // stops above, verified 2026-09-07 — busRoutePatterns (2,403) is every
  // gtfs_bus.routes row, i.e. one per (route number × direction × schedule
  // variant like UP/DOWN/short-turning "STL"): e.g. "165" alone appears as
  // 165UP, 165DOWN, 165ADOWN, 165ASTLUP, etc. Unlike stops, there's no
  // authoritative dedup key in the source data (stops have stop_code; routes
  // have nothing equivalent) — two different reasonable ways of stripping
  // direction/variant suffixes gave 474 and 1,096 distinct codes, so neither
  // is a defensible "real" count to assert as our own. External citation for
  // context only, NOT verified against this feed's vintage: DTC operated
  // ~259 of its own routes, ~606 total across DTC+DIMTS as of 2023 (deccan
  // herald / dtc.delhi.gov.in coverage). Public-facing copy must NOT call
  // busRoutePatterns "bus routes" — see ProofStrip.tsx.
  busRoutePatterns: 2403,
  metroStops: 262,
  // Distinct color-coded lines in our own GTFS feed (grouping route_long_name
  // by its color prefix: RED/YELLOW/BLUE/GREEN/VIOLET/PINK/MAGENTA/GRAY/
  // ORANGE-AIRPORT/AQUA/RAPID = 11), verified 2026-09-07 — NOT the raw
  // gtfs_metro.routes row count (36 = every line × direction × branch
  // pattern, e.g. RED alone is 4 rows). DMRC's own currently-reported total
  // is 12 lines (~395km/289 stations, 2025) — one more than our feed groups
  // into, likely a branch DMRC counts separately. Also: our AQUA group is
  // Noida's Aqua Line, which DMRC's own official account states explicitly
  // does NOT come under DMRC (it's NMRC) — so "(DMRC)" is over-broad for
  // that one line specifically whenever this figure is captioned by operator.
  metroLines: 11,
  wards: 290,
  wardsWithZeroBusStops: 23,
  stopTimes: 3724320,
} as const;

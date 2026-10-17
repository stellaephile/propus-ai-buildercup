/**
 * Demo-mode query builders. Every number here traces to a real source:
 *   - ward metrics: live derived.ward_metrics snapshot, 2026-07-11 (see lib/data/wardMetrics.ts)
 *   - stop/station coordinates: raw GTFS (Observed)
 *   - catchment counts: computed live in the browser from real coordinates
 * Where a value would require the backend (WorldPop population), we render an
 * honest empty state — never an invented number (CLAUDE.md §3.1).
 */

import type { Methodology, PropusResult, ResultKind } from "@propus/contract";
import { bboxOf, circlePolygon, countWithin, DELHI_CENTER } from "../geo";
import { KASHMERE_GATE } from "../data/metroStops";
import {
  BEST_WARDS,
  NETWORK_TOTALS,
  PROVENANCE,
  WORST_WARDS,
} from "../data/wardMetrics";
import { wardNameOf } from "../data/useStopsData";
import type { StopsData } from "../data/useStopsData";

export type QueryIntent =
  | "worst_wards"
  | "comparison"
  | "catchment"
  | "density_rank"
  | "scenario"
  | "unknown";

export interface BuiltQuery {
  intent: QueryIntent;
  steps: string[];
  results: { payload: PropusResult; methodology?: Methodology }[];
  notices: string[];
}

export const HEADLINE_QUERIES = [
  "Which wards have the worst transit access?",
  "Compare transit access in Kashmere Gate vs Sangam Vihar",
  "Show the 500m catchment for Kashmere Gate",
  "Rank the best-served wards by bus stops",
  "If a metro station is added here, what falls within 800m?",
] as const;

export function classify(q: string): QueryIntent {
  const s = q.toLowerCase();
  if (/(worst|underserved|poor|gap).*(ward|access)|ward.*worst/.test(s)) return "worst_wards";
  if (/compare|versus| vs /.test(s)) return "comparison";
  // scenario must be tested before catchment: "if a metro station is added … within 800m"
  // also matches the catchment regex (`within \d+ ?m`), so order matters here.
  if (/if .*(metro|station)|scenario|added/.test(s)) return "scenario";
  if (/catchment|buffer|within \d+ ?m|walkshed/.test(s)) return "catchment";
  if (/rank|top \d+|density|best[- ]served/.test(s)) return "density_rank";
  return "unknown";
}

const wardMethodology: Methodology = {
  formula:
    "transit_score = weighted composite of stop count, peak AM frequency, and metro proximity per ward (pipeline/compute.py step 6)",
  crs: PROVENANCE.crs,
  sources: PROVENANCE.attribution.slice(),
  evidence: "Calculated",
  caveats: [
    "Snapshot of derived.ward_metrics taken 2026-07-11; not a live query in demo mode",
    "IPT/informal transit is not modelled",
  ],
};

function fmtFreq(f: number | null): string {
  return f === null ? "—" : f.toFixed(2);
}

function wardHighlightLayer(
  wards: GeoJSON.FeatureCollection,
  names: string[],
  tokenKey: string,
  label: string
): PropusResult | null {
  const wanted = new Set(names.map((n) => n.toUpperCase()));
  const features = wards.features.filter((f) =>
    wanted.has(wardNameOf(f.properties as Record<string, unknown>))
  );
  if (features.length === 0) return null;
  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
  // Frame the selected wards, not the whole NCR (BUGS.md B5). Bounds win over
  // center/zoom in the conductor; center/zoom stays as a safe fallback.
  const bounds = bboxOf(fc) ?? undefined;
  return {
    kind: "map_layer",
    layer: "choropleth",
    geojson: fc,
    style: { fillToken: tokenKey, lineToken: "celestial", opacity: 0.55 },
    camera: { center: DELHI_CENTER, zoom: 9.6, bounds },
    label,
    legend: [{ label, token: tokenKey }],
  };
}

export function buildWorstWards(wards: GeoJSON.FeatureCollection | null): BuiltQuery {
  const results: BuiltQuery["results"] = [];
  const notices: string[] = [];

  results.push({
    payload: {
      kind: "data_table",
      columns: ["Ward", "Bus stops", "Peak freq/hr", "Metro ≤1km", "Transit score"],
      rows: WORST_WARDS.map((w) => [
        w.ward,
        w.stops,
        fmtFreq(w.freqPerHr),
        w.metro ? "Yes" : "No",
        w.score.toFixed(4),
      ]),
      rowIds: WORST_WARDS.map((w) => w.ward),
      alertRows: WORST_WARDS.map((_, i) => i),
      evidence: "Calculated",
    },
    methodology: wardMethodology,
  });

  if (wards) {
    const layer = wardHighlightLayer(
      wards,
      WORST_WARDS.map((w) => w.ward),
      "alert",
      "Underserved wards (worst 10)"
    );
    if (layer) results.push({ payload: layer, methodology: wardMethodology });
    else
      notices.push(
        "Ward names in fixtures/wards.geojson did not match the metric records — showing table only."
      );
  } else {
    notices.push(
      "Ward geometry not loaded. Run `npm run wards` to fetch real MCD boundaries (OpenCity/DataMeet, see ATTRIBUTION.md)."
    );
  }

  results.push({
    payload: {
      kind: "stat_cards",
      cards: [
        {
          label: "Wards with zero bus stops",
          value: String(NETWORK_TOTALS.wardsWithZeroBusStops),
          unit: `of ${NETWORK_TOTALS.wards}`,
          evidence: "Calculated",
          alert: true,
        },
        {
          label: "Wards scoring 0.0000",
          value: "8",
          evidence: "Calculated",
          alert: true,
        },
        {
          label: "Wards analysed",
          value: String(NETWORK_TOTALS.wards),
          evidence: "Observed",
        },
      ],
    },
    methodology: wardMethodology,
  });

  return {
    intent: "worst_wards",
    steps: [
      "Reading derived.ward_metrics (snapshot, 2026-07-11)",
      `Ranking ${NETWORK_TOTALS.wards} wards by transit_score`,
      "Resolving ward geometry (EPSG:4326 display)",
      "Composing table, map highlight, and summary",
    ],
    results,
    notices,
  };
}

export function buildComparison(wards: GeoJSON.FeatureCollection | null): BuiltQuery {
  const a = BEST_WARDS[0]; // KASHMERE GATE — real
  const b = WORST_WARDS[0]; // SANGAM VIHAR — real
  const results: BuiltQuery["results"] = [
    {
      payload: {
        kind: "comparison",
        a: { id: a.ward, name: "Kashmere Gate" },
        b: { id: b.ward, name: "Sangam Vihar" },
        metrics: [
          { label: "Bus stops", a: String(a.stops), b: String(b.stops), evidence: "Calculated" },
          {
            label: "Peak frequency (buses/hr)",
            a: fmtFreq(a.freqPerHr),
            b: fmtFreq(b.freqPerHr),
            evidence: "Calculated",
          },
          { label: "Metro within 1km", a: "Yes", b: "No", evidence: "Calculated" },
          {
            label: "Transit score",
            a: a.score.toFixed(4),
            b: b.score.toFixed(4),
            evidence: "Calculated",
          },
        ],
        // "Widest gap" holds for transit_score (top ward vs 0.0000), not stop
        // count — BAWANA has the most stops (216) but scores 0.4714.
        disparityLabel:
          "The widest transit-score gap in the network: 110 bus stops and 35.5 buses/hr against zero service.",
      },
      methodology: wardMethodology,
    },
  ];
  const notices: string[] = [];
  if (wards) {
    // two layers so the amber scalpel touches ONLY the underserved ward
    const layerA = wardHighlightLayer(wards, [a.ward], "ramp3", "Kashmere Gate (best-served)");
    const layerB = wardHighlightLayer(
      wards,
      [b.ward],
      "alert",
      "Sangam Vihar (underserved)"
    );
    if (layerA) results.push({ payload: layerA, methodology: wardMethodology });
    if (layerB) results.push({ payload: layerB, methodology: wardMethodology });
  } else {
    notices.push("Ward geometry not loaded — run `npm run wards` for the map highlight.");
  }
  return {
    intent: "comparison",
    steps: [
      "Fetching ward metrics for KASHMERE GATE and SANGAM VIHAR",
      "Computing metric deltas",
      "Highlighting compared wards",
    ],
    results,
    notices,
  };
}

export function buildCatchment(stops: StopsData): BuiltQuery {
  const RADIUS = 500;
  const buffer = circlePolygon(KASHMERE_GATE, RADIUS);
  const nStops = countWithin(stops.points, KASHMERE_GATE, RADIUS);
  const sampleNote = stops.full
    ? undefined
    : `within the committed ${stops.points.length}-stop sample — run npm run fixtures for the full network`;

  const methodology: Methodology = {
    formula: `500 m geodesic buffer around Kashmere Gate station (28.667879 N, 77.228012 E); point-in-radius count by haversine. Server version: ST_Buffer in EPSG:32643, reprojected to EPSG:4326.`,
    crs: "Browser: geodesic approximation on WGS84. Authoritative: EPSG:32643 (UTM 43N).",
    sources: [
      "© Delhi Metro Rail Corporation via OTD (station location)",
      "© Open Transit Data, Government of Delhi (bus stops)",
    ],
    evidence: "Calculated",
    caveats: ["Euclidean catchment, not network walk distance"],
  };

  return {
    intent: "catchment",
    steps: [
      "Locating Kashmere Gate station (Observed, DMRC GTFS)",
      `Buffering ${RADIUS} m (geodesic; server uses EPSG:32643)`,
      `Counting bus stops inside the buffer${stops.full ? "" : " (sample)"}`,
    ],
    results: [
      {
        payload: {
          kind: "map_layer",
          layer: "buffer",
          geojson: {
            type: "FeatureCollection",
            features: [
              buffer,
              {
                type: "Feature",
                properties: { name: "Kashmere Gate", mode: "metro" },
                geometry: { type: "Point", coordinates: KASHMERE_GATE },
              },
            ],
          },
          style: { fillToken: "bufferFill", lineToken: "buffer", opacity: 0.18 },
          camera: { center: KASHMERE_GATE, zoom: 13.6 },
          label: "500 m catchment — Kashmere Gate",
          legend: [{ label: "500 m catchment", token: "buffer" }],
        },
        methodology,
      },
      {
        payload: {
          kind: "stat_cards",
          cards: [
            {
              label: "Bus stops within 500 m",
              value: String(nStops),
              evidence: "Calculated",
              note: sampleNote,
            },
            {
              label: "Interchange",
              value: "3 lines",
              unit: "Red · Yellow · Violet",
              evidence: "Observed",
            },
            {
              label: "Population within 500 m",
              value: "—",
              evidence: "Estimated",
              note: "Requires WorldPop zonal stats (backend) — not shown rather than guessed",
            },
          ],
        },
        methodology,
      },
    ],
    notices: [],
  };
}

export function buildDensityRank(): BuiltQuery {
  return {
    intent: "density_rank",
    steps: [
      "Reading derived.ward_metrics (snapshot, 2026-07-11)",
      "Sorting best-served wards by bus stop count",
    ],
    results: [
      {
        payload: {
          kind: "bar_chart",
          title: "Bus stops — 10 best-served wards (by transit score)",
          x: "Ward",
          y: "Bus stops",
          series: [...BEST_WARDS]
            .sort((x, y) => y.stops - x.stops)
            .map((w) => ({ label: w.ward, value: w.stops })),
          evidence: "Calculated",
        },
        methodology: {
          ...wardMethodology,
          formula:
            "Bus stop count per ward via ST_Within(stop.geom, ward.geometry) in EPSG:32643 (pipeline/compute.py step 1). Stops-per-km² ranking needs ward areas — not shown until wired.",
        },
      },
    ],
    notices: [
      "True density (stops/km²) needs ward areas from the live DB — showing real stop counts for the best-served wards instead.",
    ],
  };
}

export function buildScenario(
  stops: StopsData,
  point: [number, number] | null,
  radiusM: number
): BuiltQuery {
  if (!point) {
    return {
      intent: "scenario",
      steps: ["Waiting for a candidate site — click the map to place the station"],
      results: [],
      notices: ["Click anywhere on the map to drop a candidate metro station."],
    };
  }
  const buffer = circlePolygon(point, radiusM);
  const nStops = countWithin(stops.points, point, radiusM);
  const methodology: Methodology = {
    formula: `${radiusM} m geodesic buffer around the candidate point; live recount on slider release. Server version: ST_Buffer + WorldPop zonal stats in EPSG:32643.`,
    crs: "Browser: geodesic approximation on WGS84. Authoritative: EPSG:32643.",
    sources: ["© Open Transit Data, Government of Delhi (bus stops)"],
    evidence: "Calculated",
  };
  return {
    intent: "scenario",
    steps: [
      `Buffering ${radiusM} m around the candidate site`,
      "Counting connecting bus stops inside the buffer",
    ],
    results: [
      {
        payload: {
          kind: "map_layer",
          layer: "buffer",
          geojson: {
            type: "FeatureCollection",
            features: [
              buffer,
              {
                type: "Feature",
                properties: { name: "Candidate station", candidate: true },
                geometry: { type: "Point", coordinates: point },
              },
            ],
          },
          style: { fillToken: "bufferFill", lineToken: "buffer", opacity: 0.18 },
          camera: { center: point, zoom: 13 },
          label: `Scenario — ${radiusM} m around candidate`,
          legend: [{ label: `${radiusM} m scenario buffer`, token: "buffer" }],
        },
        methodology,
      },
      {
        payload: {
          kind: "stat_cards",
          cards: [
            {
              label: `Bus stops within ${radiusM} m`,
              value: String(nStops),
              evidence: "Calculated",
              note: stops.full ? undefined : "sample — run npm run fixtures for the full network",
            },
            {
              label: "New residents within reach",
              value: "—",
              evidence: "Modelled",
              note: "Requires WorldPop raster on the backend — not shown rather than guessed",
            },
          ],
        },
        methodology,
      },
    ],
    notices: [],
  };
}

export function buildUnknown(): BuiltQuery {
  return {
    intent: "unknown",
    steps: ["Parsing the question"],
    results: [],
    notices: [
      "Demo mode answers the five headline queries. Try one from the suggestions — live-LLM mode handles free-form questions.",
    ],
  };
}

export function kindsOf(b: BuiltQuery): ResultKind[] {
  return b.results.map((r) => r.payload.kind);
}

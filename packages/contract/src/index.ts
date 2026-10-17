/**
 * @propus/contract — the single source of truth for the typed result contract.
 * Mirrored into FastAPI Pydantic models (apps/api). CLAUDE.md §6 / §6a.
 */

export type Evidence = "Observed" | "Calculated" | "Estimated" | "Modelled";

export interface Entity {
  id: string;
  name: string;
}

export interface CameraSpec {
  center: [number, number]; // [lon, lat] WGS84
  zoom: number;
  pitch?: number;
  bearing?: number;
  /**
   * Optional extent to frame the answer, [west, south, east, north] WGS84.
   * When present the conductor fits these bounds (with padding) instead of
   * using center/zoom — this is what actually frames the result (BUGS.md B5).
   */
  bounds?: [number, number, number, number];
}

export interface MapStyleSpec {
  /** token key into lib/tokens colors — never a raw hex */
  fillToken?: string;
  lineToken?: string;
  /** property to drive a data ramp, e.g. "transit_score" */
  rampProperty?: string;
  /**
   * Feature property whose value selects a per-feature color token (e.g.
   * "metro_line" holding a DMRC line prefix, resolved via metroLineTokens).
   * Features without a match fall back to lineToken. Still tokens-only: the
   * GeoJSON carries the data value, lib/tokens maps it to a color.
   */
  colorProperty?: string;
  opacity?: number;
  /**
   * "buffer" layers get a decorative dashed offset ring (§6b "buffer bloom")
   * by default — right for a single clean catchment circle, wrong for a
   * MultiPolygon with many disjoint parts (MapLibre draws the ring around
   * every separate blob). Explicit false suppresses it; absent/true keeps
   * existing behaviour.
   */
  bloomRing?: boolean;
}

export type MapLayerKind = "choropleth" | "points" | "lines" | "buffer" | "hex3d";

export interface StatCard {
  label: string;
  value: string;
  unit?: string;
  evidence: Evidence;
  /** amber alert styling — reserved for underserved/alert data points only */
  alert?: boolean;
  note?: string;
}

export type PropusResult =
  | { kind: "stat_cards"; cards: StatCard[] }
  | {
      kind: "data_table";
      columns: string[];
      rows: (string | number)[][];
      highlight?: number;
      evidence: Evidence;
      /** row indices that represent underserved/alert entities (amber) */
      alertRows?: number[];
      /** ward/entity ids parallel to rows, for map hover sync */
      rowIds?: string[];
    }
  | {
      kind: "bar_chart";
      x: string;
      y: string;
      series: { label: string; value: number }[];
      evidence: Evidence;
      title?: string;
    }
  | {
      kind: "line_chart";
      x: string;
      y: string;
      series: { label: string; points: { x: number; y: number }[] }[];
      evidence: Evidence;
      title?: string;
    }
  | {
      kind: "scatter_chart";
      /** data keys, e.g. "pop_total" / "bus_stop_count" */
      x: string;
      y: string;
      /** human axis titles — renderers fall back to the x/y keys when absent */
      xLabel?: string;
      yLabel?: string;
      /** alert points render in the amber token — underserved/alert data ONLY (§3.4) */
      points: { label: string; x: number; y: number; alert?: boolean }[];
      evidence: Evidence;
      title?: string;
      methodology?: Methodology;
    }
  | {
      kind: "pivot_table";
      /** label for the row dimension (first column header) */
      rowDim: string;
      /** column headers; "Group / Leaf" entries render as a grouped two-row header */
      colDims: string[];
      rows: { label: string; values: (string | number | null)[] }[];
      evidence: Evidence;
      title?: string;
      methodology?: Methodology;
    }
  | {
      kind: "comparison";
      a: Entity;
      b: Entity;
      metrics: { label: string; a: string; b: string; evidence: Evidence }[];
      disparityPct?: number;
      disparityLabel?: string;
    }
  | {
      kind: "map_layer";
      layer: MapLayerKind;
      geojson: GeoJSON.FeatureCollection;
      style: MapStyleSpec;
      camera?: CameraSpec;
      /** human name for the layer manager */
      label?: string;
      legend?: { label: string; token: string }[];
    };

export type ResultKind = PropusResult["kind"];

export interface Methodology {
  formula: string;
  crs: string; // e.g. "EPSG:32643 (UTM 43N) for measurement; EPSG:4326 for display"
  sources: string[]; // only entries listed in ATTRIBUTION.md
  evidence: Evidence;
  caveats?: string[];
}

export type PropusEvent =
  | { event: "plan"; kinds: ResultKind[] }
  | { event: "reasoning_step"; step: string }
  | { event: "result"; index: number; payload: PropusResult; methodology?: Methodology }
  | { event: "done"; query_id: string; ms: number; mode: "demo" | "live"; model?: string }
  | { event: "error"; message: string; recoverable: boolean };

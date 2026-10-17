"use client";

/**
 * Switch on `kind` — one component per member of the PropusResult union.
 * Rendered inside the stagger container of the reveal choreography (§6b).
 */

import type { Methodology, PropusResult } from "@propus/contract";
import { BarChartCard, LineChartCard, ScatterChartCard } from "./Charts";
import { Comparison } from "./Comparison";
import { DataTable } from "./DataTable";
import { MapLayerCard } from "./MapLayerCard";
import { PivotTable } from "./PivotTable";
import { StatCards } from "./StatCards";

export function ResultRenderer({
  result,
  methodology,
  onHoverRow,
}: {
  result: PropusResult;
  methodology?: Methodology;
  onHoverRow?: (id: string | null) => void;
}) {
  switch (result.kind) {
    case "stat_cards":
      return <StatCards {...result} methodology={methodology} />;
    case "data_table":
      return <DataTable {...result} methodology={methodology} onHoverRow={onHoverRow} />;
    case "bar_chart":
      return <BarChartCard {...result} methodology={methodology} />;
    case "line_chart":
      return <LineChartCard {...result} methodology={methodology} />;
    case "scatter_chart":
      return <ScatterChartCard {...result} methodology={methodology ?? result.methodology} />;
    case "pivot_table":
      return <PivotTable {...result} methodology={methodology ?? result.methodology} />;
    case "comparison":
      return <Comparison {...result} methodology={methodology} />;
    case "map_layer":
      return <MapLayerCard {...result} methodology={methodology} />;
  }
}

"""
apps/api/schemas.py
--------------------
Pydantic mirror of packages/contract/src/index.ts — the single source of
truth for the typed result contract (CLAUDE.md §6 / §6a). Keep these two
files in sync by hand; there is no codegen step in this prototype.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

Evidence = Literal["Observed", "Calculated", "Estimated", "Modelled"]
MapLayerKind = Literal["choropleth", "points", "lines", "buffer", "hex3d"]


class Entity(BaseModel):
    id: str
    name: str


class CameraSpec(BaseModel):
    center: tuple[float, float]  # [lon, lat] WGS84
    zoom: float
    pitch: float | None = None
    bearing: float | None = None
    # [west, south, east, north] WGS84 — when present the conductor fits these
    # bounds instead of center/zoom (mirrors the TS contract, BUGS.md B5)
    bounds: tuple[float, float, float, float] | None = None


class MapStyleSpec(BaseModel):
    fillToken: str | None = None
    lineToken: str | None = None
    rampProperty: str | None = None
    # feature property whose value selects a per-feature color token
    # (e.g. "metro_line" holding a DMRC line prefix); falls back to lineToken
    colorProperty: str | None = None
    opacity: float | None = None
    # "buffer" layers get a decorative dashed offset ring (CLAUDE.md §6b
    # "buffer bloom") by default — right for a single clean catchment circle
    # (get_metro_catchment), wrong for a MultiPolygon with many disjoint
    # parts (get_pop_walk_access's citywide walkshed), where MapLibre draws
    # that dashed ring around every separate blob and it reads as noise.
    # Explicit False suppresses it; absent/True keeps existing behaviour.
    bloomRing: bool | None = None


class StatCard(BaseModel):
    label: str
    value: str
    unit: str | None = None
    evidence: Evidence
    alert: bool | None = None
    note: str | None = None


class LegendEntry(BaseModel):
    label: str
    token: str


# Defined before the result models — scatter_chart / pivot_table embed it.
class Methodology(BaseModel):
    formula: str
    crs: str
    sources: list[str]
    evidence: Evidence
    caveats: list[str] | None = None


class StatCardsResult(BaseModel):
    kind: Literal["stat_cards"] = "stat_cards"
    cards: list[StatCard]


class DataTableResult(BaseModel):
    kind: Literal["data_table"] = "data_table"
    columns: list[str]
    rows: list[list[str | float | int]]
    highlight: int | None = None
    evidence: Evidence
    alertRows: list[int] | None = None
    rowIds: list[str] | None = None


class BarSeriesPoint(BaseModel):
    label: str
    value: float


class BarChartResult(BaseModel):
    kind: Literal["bar_chart"] = "bar_chart"
    x: str
    y: str
    series: list[BarSeriesPoint]
    evidence: Evidence
    title: str | None = None


class LinePoint(BaseModel):
    x: float
    y: float


class LineSeries(BaseModel):
    label: str
    points: list[LinePoint]


class LineChartResult(BaseModel):
    kind: Literal["line_chart"] = "line_chart"
    x: str
    y: str
    series: list[LineSeries]
    evidence: Evidence
    title: str | None = None


class ScatterPoint(BaseModel):
    label: str
    x: float
    y: float
    # amber token — underserved/alert data points ONLY (CLAUDE.md §3.4)
    alert: bool | None = None


class ScatterChartResult(BaseModel):
    kind: Literal["scatter_chart"] = "scatter_chart"
    x: str
    y: str
    xLabel: str | None = None
    yLabel: str | None = None
    points: list[ScatterPoint]
    evidence: Evidence
    title: str | None = None
    methodology: Methodology | None = None


class PivotRow(BaseModel):
    label: str
    values: list[str | float | int | None]


class PivotTableResult(BaseModel):
    kind: Literal["pivot_table"] = "pivot_table"
    rowDim: str
    # "Group / Leaf" entries render as a grouped two-row header
    colDims: list[str]
    rows: list[PivotRow]
    evidence: Evidence
    title: str | None = None
    methodology: Methodology | None = None


class ComparisonMetric(BaseModel):
    label: str
    a: str
    b: str
    evidence: Evidence


class ComparisonResult(BaseModel):
    kind: Literal["comparison"] = "comparison"
    a: Entity
    b: Entity
    metrics: list[ComparisonMetric]
    disparityPct: float | None = None
    disparityLabel: str | None = None


class MapLayerResult(BaseModel):
    kind: Literal["map_layer"] = "map_layer"
    layer: MapLayerKind
    geojson: dict
    style: MapStyleSpec
    camera: CameraSpec | None = None
    label: str | None = None
    legend: list[LegendEntry] | None = None


PropusResult = Annotated[
    Union[
        StatCardsResult,
        DataTableResult,
        BarChartResult,
        LineChartResult,
        ScatterChartResult,
        PivotTableResult,
        ComparisonResult,
        MapLayerResult,
    ],
    Field(discriminator="kind"),
]

ResultKind = Literal[
    "stat_cards", "data_table", "bar_chart", "line_chart",
    "scatter_chart", "pivot_table", "comparison", "map_layer",
]


class PlanEvent(BaseModel):
    event: Literal["plan"] = "plan"
    kinds: list[ResultKind]


class ReasoningStepEvent(BaseModel):
    event: Literal["reasoning_step"] = "reasoning_step"
    step: str


class ResultEvent(BaseModel):
    event: Literal["result"] = "result"
    index: int
    payload: PropusResult
    methodology: Methodology | None = None


class DoneEvent(BaseModel):
    event: Literal["done"] = "done"
    query_id: str
    ms: int
    mode: Literal["demo", "live"]
    model: str | None = None


class ErrorEvent(BaseModel):
    event: Literal["error"] = "error"
    message: str
    recoverable: bool


PropusEvent = Annotated[
    Union[PlanEvent, ReasoningStepEvent, ResultEvent, DoneEvent, ErrorEvent],
    Field(discriminator="event"),
]

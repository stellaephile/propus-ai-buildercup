"use client";

/**
 * bar_chart + line_chart + scatter_chart renderers — Recharts styled to
 * tokens. Bars/points for underserved entities use amber (the scalpel, §3.4);
 * everything else uses the primary ramp.
 */

import { useReducedMotion } from "framer-motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { Methodology, PropusResult } from "@propus/contract";
import { useThemePalette } from "@/lib/theme";
import { typeScale } from "@/lib/tokens";
import { EvidenceTag } from "../EvidenceTag";
import { ResultCard } from "./ResultCard";

type BarProps = Extract<PropusResult, { kind: "bar_chart" }> & { methodology?: Methodology };
type LineProps = Extract<PropusResult, { kind: "line_chart" }> & { methodology?: Methodology };
type ScatterProps = Extract<PropusResult, { kind: "scatter_chart" }>;

/**
 * hex → rgba() at a fixed alpha — lets the one sanctioned floating-element
 * shadow (DESIGN.md §1.4: "24px blur, 0 offset, ink at 4%") tint itself to
 * the live `ink` token instead of the tooltip falling back on a border.
 */
function ambientShadow(inkHex: string) {
  const n = parseInt(inkHex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `0 0 24px 0 rgba(${r}, ${g}, ${b}, 0.04)`;
}

/** "55000" / "110000" tabular ticks collide once an axis has 3+ six-figure
 * values in the space a card affords (no gap between adjacent labels, just
 * digits running together) — compact notation ("55K") keeps every tick
 * legible without widening the axis. Full precision still shows in the
 * per-point tooltip; only the tick labels compact. */
const compactNumber = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function BarChartCard({ title, x, y, series, evidence, methodology }: BarProps) {
  const reduced = !!useReducedMotion();
  const { palette: c } = useThemePalette();
  const axisStyle = { fontFamily: "var(--font-mono)", fontSize: typeScale.axis, fill: c.inkMuted };
  return (
    <ResultCard title={title ?? `${y} by ${x}`} methodology={methodology} actions={<EvidenceTag evidence={evidence} />}>
      <div className="h-64 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
            <CartesianGrid stroke={c.border} horizontal={false} />
            <XAxis
              type="number"
              tick={axisStyle}
              tickFormatter={(v) => compactNumber.format(v)}
              stroke={c.borderStrong}
            />
            <YAxis
              type="category"
              dataKey="label"
              width={130}
              tick={{ ...axisStyle, fontSize: typeScale.axis }}
              stroke={c.borderStrong}
              // Recharts auto-thins category ticks — every ward keeps its label
              interval={0}
            />
            <Tooltip
              cursor={{ fill: c.vellum }}
              contentStyle={{
                background: c.sheet,
                border: "none",
                borderRadius: 6,
                boxShadow: ambientShadow(c.ink),
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            />
            <Bar dataKey="value" fill={c.primary} radius={[0, 3, 3, 0]} isAnimationActive={!reduced} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ResultCard>
  );
}

export function ScatterChartCard({
  title,
  x,
  y,
  xLabel,
  yLabel,
  points,
  evidence,
  methodology,
}: ScatterProps) {
  const reduced = !!useReducedMotion();
  const { palette: c } = useThemePalette();
  const axisStyle = { fontFamily: "var(--font-mono)", fontSize: typeScale.axis, fill: c.inkMuted };
  const xTitle = xLabel ?? x;
  const yTitle = yLabel ?? y;
  return (
    <ResultCard
      title={title ?? `${yTitle} vs ${xTitle}`}
      methodology={methodology}
      actions={<EvidenceTag evidence={evidence} />}
    >
      <div className="h-64 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ left: 28, right: 24, top: 8, bottom: 28 }}>
            <CartesianGrid stroke={c.border} />
            <XAxis
              type="number"
              dataKey="x"
              name={xTitle}
              tick={axisStyle}
              tickFormatter={(v) => compactNumber.format(v)}
              stroke={c.borderStrong}
              label={{ value: xTitle, position: "bottom", offset: 16, ...axisStyle }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={yTitle}
              tick={axisStyle}
              stroke={c.borderStrong}
              label={{ value: yTitle, angle: -90, position: "insideLeft", offset: -12, ...axisStyle }}
            />
            {/* fixed symbol area — Recharts' default renders near-invisible dots */}
            <ZAxis range={[110, 110]} />
            <Tooltip
              cursor={{ stroke: c.borderStrong, strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as ScatterProps["points"][number];
                return (
                  <div
                    style={{
                      background: c.sheet,
                      border: "none",
                      borderRadius: 6,
                      boxShadow: ambientShadow(c.ink),
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      padding: "6px 8px",
                    }}
                  >
                    <div style={{ color: c.ink }}>{p.label}</div>
                    <div style={{ color: p.alert ? c.alertInk : c.inkMuted }}>
                      {xTitle}: {p.x} · {yTitle}: {p.y}
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={points} isAnimationActive={!reduced}>
              {points.map((p, i) => (
                // amber is the scalpel — alert points only (§3.4)
                <Cell key={i} fill={p.alert ? c.alert : c.primary} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </ResultCard>
  );
}

export function LineChartCard({ title, x, y, series, evidence, methodology }: LineProps) {
  const reduced = !!useReducedMotion();
  const { palette: c } = useThemePalette();
  const axisStyle = { fontFamily: "var(--font-mono)", fontSize: typeScale.axis, fill: c.inkMuted };
  // merge series into recharts row format
  const xs = Array.from(new Set(series.flatMap((s) => s.points.map((p) => p.x)))).sort(
    (a, b) => a - b
  );
  const data = xs.map((xv) => {
    const row: Record<string, number> = { x: xv };
    for (const s of series) {
      const p = s.points.find((pt) => pt.x === xv);
      if (p) row[s.label] = p.y;
    }
    return row;
  });
  const palette = [c.primary, c.celestialMuted, c.alert];
  return (
    <ResultCard title={title ?? `${y} by ${x}`} methodology={methodology} actions={<EvidenceTag evidence={evidence} />}>
      <div className="h-56 px-2 py-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
            <CartesianGrid stroke={c.border} vertical={false} />
            {/* x is the series' own domain (year, distance, …), not a
                magnitude — compact notation would mangle e.g. a year into
                "2K", so only the value axis (y) gets it. */}
            <XAxis dataKey="x" tick={axisStyle} stroke={c.borderStrong} />
            <YAxis
              tick={axisStyle}
              tickFormatter={(v) => compactNumber.format(v)}
              stroke={c.borderStrong}
            />
            <Tooltip
              contentStyle={{
                background: c.sheet,
                border: "none",
                borderRadius: 6,
                boxShadow: ambientShadow(c.ink),
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            />
            {series.map((s, i) => (
              <Line
                key={s.label}
                dataKey={s.label}
                stroke={palette[i % palette.length]}
                strokeWidth={1.8}
                dot={false}
                isAnimationActive={!reduced}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </ResultCard>
  );
}

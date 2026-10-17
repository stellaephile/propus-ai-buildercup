"use client";

/**
 * comparison renderer — dual-entity metrics with the disparity stat (the
 * query-#2 AHA). disparityPct counts up (D2); when a pct would be undefined
 * (division by zero service), we show the disparityLabel instead of inventing
 * a number.
 */

import type { Methodology, PropusResult } from "@propus/contract";
import { CountUp } from "../CountUp";
import { EvidenceTag } from "../EvidenceTag";
import { ResultCard } from "./ResultCard";

type Props = Extract<PropusResult, { kind: "comparison" }> & { methodology?: Methodology };

export function Comparison({ a, b, metrics, disparityPct, disparityLabel, methodology }: Props) {
  return (
    <ResultCard title={`${a.name} vs ${b.name}`} methodology={methodology}>
      <div className="px-4 py-3">
        <table className="w-full text-sm">
          <thead>
            {/* px-3 on every cell: with no gap between the value columns'
                right-aligned text they can end up touching (e.g.
                "0.68420.0000") whenever a header wraps ("Sangam\nVihar")
                and shrinks its column below the value text's own width. */}
            <tr className="text-xs text-inkMuted">
              <th className="text-left font-medium px-3 py-1">Metric</th>
              <th className="text-right font-medium px-3 py-1">{a.name}</th>
              <th className="text-right font-medium px-3 py-1">{b.name}</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => (
              <tr key={m.label} className={i % 2 === 1 ? "bg-vellumShade/50" : ""}>
                <td className="px-3 py-1.5 text-inkMuted flex items-center gap-1.5">
                  {m.label} <EvidenceTag evidence={m.evidence} />
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">{m.a}</td>
                <td
                  className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                    m.b === "0" || m.b === "—" || m.b === "No"
                      ? "text-alert"
                      : "text-ink"
                  }`}
                >
                  {m.b}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 rounded-md bg-vellum px-3 py-2.5">
          {typeof disparityPct === "number" ? (
            <div className="font-mono text-3xl tabular-nums text-alert">
              {/* A negative disparityPct already carries its own "-" — the
                  literal template `+${disparityPct}%` blindly prepended a
                  "+" regardless of sign, rendering a live comparison where
                  `a` trails `b` as "+-47%" (confirmed: HAUZ KHAS vs MINTO
                  ROAD). Only add the "+" when the value is actually
                  positive; let a negative print its own sign once. */}
              <CountUp value={`${disparityPct >= 0 ? "+" : ""}${disparityPct}%`} />
              <span className="ml-2 align-middle text-xs text-inkMuted font-sans">disparity</span>
            </div>
          ) : (
            <p className="text-sm text-ink">
              <span className="font-mono text-alert">Disparity —</span>{" "}
              {disparityLabel}
            </p>
          )}
        </div>
      </div>
    </ResultCard>
  );
}

"use client";

/**
 * pivot_table renderer — a grouped-header table reusing the data-table
 * styling (§9 export included). colDims entries of the form "Group / Leaf"
 * render as a two-row header with the group cell spanning its leaves; flat
 * colDims render a single header row. Null cells render as an em dash —
 * an honest gap, never a fabricated zero (§3.1).
 */

import type { Methodology, PropusResult } from "@propus/contract";
import { EvidenceTag } from "../EvidenceTag";
import { ResultCard } from "./ResultCard";

type Props = Extract<PropusResult, { kind: "pivot_table" }>;

const GROUP_SEP = " / ";

function toCSV(columns: string[], rows: (string | number | null)[][]): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function PivotTable({ title, rowDim, colDims, rows, evidence, methodology }: Props) {
  const split = colDims.map((d) => {
    const i = d.indexOf(GROUP_SEP);
    return i === -1
      ? { group: null as string | null, leaf: d }
      : { group: d.slice(0, i), leaf: d.slice(i + GROUP_SEP.length) };
  });
  const grouped = split.some((s) => s.group !== null);
  const groups: { name: string | null; span: number }[] = [];
  for (const s of split) {
    const last = groups[groups.length - 1];
    if (last && last.name !== null && last.name === s.group) last.span += 1;
    else groups.push({ name: s.group, span: 1 });
  }

  const exportCSV = () => {
    const blob = new Blob(
      [toCSV([rowDim, ...colDims], rows.map((r) => [r.label, ...r.values]))],
      { type: "text/csv;charset=utf-8" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "propus-pivot.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <ResultCard
      title={title}
      methodology={methodology}
      actions={
        <>
          <EvidenceTag evidence={evidence} />
          <button
            onClick={exportCSV}
            className="font-mono text-xs text-inkMuted hover:text-ink hover:bg-vellumShade border border-border rounded-sm px-1.5 py-0.5 transition-colors"
          >
            CSV ↓
          </button>
        </>
      }
    >
      <table className="w-full text-sm">
        <thead>
          {grouped && (
            <tr>
              <th aria-hidden />
              {groups.map((g, gi) => (
                <th
                  key={gi}
                  colSpan={g.span}
                  scope="colgroup"
                  className="text-center px-3 pt-2 pb-1 font-mono text-xs uppercase tracking-wide text-inkFaint font-normal"
                >
                  {g.name}
                </th>
              ))}
            </tr>
          )}
          {/* Leaf header reads as an instrument-panel label band — mono,
              uppercase, tonal (vellumShade) — never a ruled-off row (Divider
              Forbiddance, DESIGN.md §4). */}
          <tr className="bg-vellumShade/70">
            <th scope="col" className="text-left px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-inkMuted">
              {rowDim}
            </th>
            {split.map((s, i) => (
              <th key={i} scope="col" className="text-left px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-inkMuted">
                {s.leaf}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr
              key={ri}
              className={`hover:bg-vellumDeep/60 ${ri % 2 === 1 ? "bg-vellumShade/50" : ""}`}
            >
              <th scope="row" className="text-left px-3 py-1.5 font-normal text-ink">
                {r.label}
              </th>
              {r.values.map((v, vi) => (
                <td
                  key={vi}
                  className={`px-3 py-1.5 font-mono tabular-nums ${
                    v === null ? "text-inkFaint" : "text-inkMuted"
                  }`}
                >
                  {v === null ? "—" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ResultCard>
  );
}

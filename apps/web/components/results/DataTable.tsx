"use client";

/**
 * data_table renderer — sortable, CSV export (§9), amber only on underserved
 * rows' key figures. Row hover syncs to the map via onHoverRow (D3), and a
 * click expands the row into an inline attribute inspector using a layoutId
 * shared-layout morph — the row and panel are the same element to Framer.
 */

import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useId, useMemo, useState } from "react";
import type { Methodology, PropusResult } from "@propus/contract";
import { motionTokens } from "@/lib/tokens";
import { EvidenceTag } from "../EvidenceTag";
import { ResultCard } from "./ResultCard";

type Props = Extract<PropusResult, { kind: "data_table" }> & {
  methodology?: Methodology;
  onHoverRow?: (id: string | null) => void;
};

function toCSV(columns: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function DataTable({ columns, rows, evidence, alertRows, rowIds, methodology, onHoverRow }: Props) {
  const reduced = useReducedMotion();
  const uid = useId();
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [asc, setAsc] = useState(true);
  const [openRow, setOpenRow] = useState<number | null>(null);
  const alerts = useMemo(() => new Set(alertRows ?? []), [alertRows]);

  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (sortCol === null) return idx;
    return idx.sort((a, b) => {
      const va = rows[a][sortCol];
      const vb = rows[b][sortCol];
      const na = Number(va);
      const nb = Number(vb);
      const cmp =
        Number.isFinite(na) && Number.isFinite(nb)
          ? na - nb
          : String(va).localeCompare(String(vb));
      return asc ? cmp : -cmp;
    });
  }, [rows, sortCol, asc]);

  const exportCSV = () => {
    const blob = new Blob([toCSV(columns, order.map((i) => rows[i]))], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "propus-result.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <ResultCard
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
          {/* Column header reads as an instrument-panel label band — mono,
              uppercase, tonal (vellumShade) — never a ruled-off row (Divider
              Forbiddance, DESIGN.md §4). */}
          <tr className="bg-vellumShade/70">
            {columns.map((c, i) => (
              <th
                key={c}
                aria-sort={sortCol === i ? (asc ? "ascending" : "descending") : undefined}
                className="text-left px-3 py-1.5 font-mono text-xs uppercase tracking-wide text-inkMuted"
              >
                <button
                  onClick={() => {
                    if (sortCol === i) setAsc(!asc);
                    else {
                      setSortCol(i);
                      setAsc(true);
                    }
                  }}
                  className="hover:text-ink flex items-center gap-1"
                >
                  {c}
                  {sortCol === i && <span aria-hidden>{asc ? "↑" : "↓"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((ri, idx) => {
            const row = rows[ri];
            const id = rowIds?.[ri];
            const isOpen = openRow === ri;
            return (
              <motion.tr
                key={ri}
                layoutId={reduced ? undefined : `row-${uid}-${ri}`}
                onMouseEnter={() => onHoverRow?.(id ?? null)}
                onMouseLeave={() => onHoverRow?.(null)}
                onClick={() => setOpenRow(isOpen ? null : ri)}
                // Rows separate by tonal zebra, never a rule (Divider
                // Forbiddance, DESIGN.md §4) — vellumShade / transparent
                // alternation, with a stronger vellumDeep tint on hover/open.
                className={`group cursor-pointer hover:bg-vellumDeep/60 ${
                  isOpen ? "bg-vellumDeep/60" : idx % 2 === 1 ? "bg-vellumShade/50" : ""
                }`}
              >
                {isOpen ? (
                  <td colSpan={columns.length} className="px-3 py-3">
                    <AnimatePresence>
                      <motion.div
                        initial={reduced ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={motionTokens.spring}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{String(row[0])}</span>
                          <span className="font-mono text-xs text-inkFaint">attributes</span>
                        </div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                          {columns.slice(1).map((c, ci) => (
                            <div key={c} className="flex justify-between py-0.5">
                              <dt className="text-inkMuted">{c}</dt>
                              <dd
                                className={`font-mono tabular-nums ${
                                  alerts.has(ri) ? "text-alertInk" : ""
                                }`}
                              >
                                {String(row[ci + 1])}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </motion.div>
                    </AnimatePresence>
                  </td>
                ) : (
                  row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`px-3 py-1.5 ${
                        ci === 0
                          ? "text-ink group-hover:text-madder" /* U5: madder selection ink */
                          : `font-mono tabular-nums ${
                              alerts.has(ri) && ci === row.length - 1
                                ? "text-alertInk"
                                : "text-inkMuted"
                            }`
                      }`}
                    >
                      {String(cell)}
                    </td>
                  ))
                )}
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </ResultCard>
  );
}

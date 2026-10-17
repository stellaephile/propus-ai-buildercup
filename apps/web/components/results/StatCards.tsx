"use client";

/**
 * stat_cards renderer — mono numerals with count-up (§6b beat 5), evidence
 * tag on every figure (§3.3). `alert` cards use the amber scalpel — data
 * points only, never fills.
 */

import type { Methodology, PropusResult } from "@propus/contract";
import { CountUp } from "../CountUp";
import { EvidenceTag } from "../EvidenceTag";
import { ResultCard } from "./ResultCard";

type Props = Extract<PropusResult, { kind: "stat_cards" }> & {
  methodology?: Methodology;
};

export function StatCards({ cards, methodology }: Props) {
  return (
    <ResultCard methodology={methodology}>
      {/*
        auto-fit/minmax instead of a fixed `repeat(N, 1fr)`: forcing N equal
        columns clips content when the pane is narrow (or user-resized down)
        — a long value like "1,92,91,624" has nowhere to go in a ~100px
        column and was getting hard-clipped by this container's own
        overflow-hidden. auto-fit collapses to fewer columns automatically as
        space shrinks; min-w-0 + break-words on each cell lets the number
        wrap instead of overflowing when it's still tight at 1 column.
      */}
      <div
        className="grid rounded-t-lg overflow-hidden"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))" }}
      >
        {/* Tiles separate by tonal zebra, not the hairline grid-gap trick
            (Divider Forbiddance, DESIGN.md §4) — sheet / vellumShade
            alternation instead of a `bg-border` 1px seam. */}
        {cards.map((c, i) => (
          <div
            key={c.label}
            className={`min-w-0 px-4 py-3 ${i % 2 === 1 ? "bg-vellumShade/60" : "bg-sheet"}`}
          >
            <div
              className={`min-w-0 break-words font-mono text-2xl tabular-nums leading-tight ${
                c.alert ? "text-alertInk" : "text-ink"
              }`}
            >
              <CountUp value={c.value} />
              {c.unit && (
                <span className="ml-1 text-xs text-inkMuted font-mono">{c.unit}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-inkMuted">
              <span>{c.label}</span>
              <EvidenceTag evidence={c.evidence} />
            </div>
            {c.note && <p className="mt-1 text-xs text-inkFaint leading-snug">{c.note}</p>}
          </div>
        ))}
      </div>
    </ResultCard>
  );
}

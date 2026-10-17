"use client";

/**
 * Result card shell — every renderer sits in one. No border: the card is a
 * tonal step (L2 `sheet` on the L0 `vellum` canvas) per the No-Line Rule
 * (DESIGN.md §1.4) — sectioning comes from fills and space, never a stroke.
 * The header, when it carries a title, is a `vellumShade` band — a tonal
 * caption strip, not a ruled-off toolbar. Title text stays sentence case:
 * §2's mono-uppercase "instrument label" register is for short labels (a
 * column header, a single field name) — a full phrase like "Kashmere Gate
 * vs Sangam Vihar" set entirely in caps loses its word shapes and reads
 * slower, so titles stay `font-medium` sans even though the band around
 * them is the same instrument-panel tonal device. Hover lift is the
 * sanctioned micro-interaction (§6b): whileHover y:-2, nothing larger. The
 * methodology drawer (§9) hangs off the footer.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import type { Methodology } from "@propus/contract";
import { motionTokens } from "@/lib/tokens";
import { EvidenceTag } from "../EvidenceTag";

export function ResultCard({
  title,
  methodology,
  children,
  actions,
}: {
  title?: string;
  methodology?: Methodology;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);

  return (
    <motion.div
      whileHover={reduced ? undefined : { y: -2 }}
      transition={motionTokens.spring}
      // §1.4: no border, no shadow at rest — cards are defined tonally; the
      // hover-lift pairs the y-shift with the one sanctioned ambient shadow (M4)
      className="rounded-lg bg-sheet hover:shadow-ambient"
    >
      {(title || actions) && (
        <div
          className={`flex items-center justify-between gap-2 rounded-t-lg px-4 py-2 ${
            title ? "bg-vellumShade/70" : ""
          }`}
        >
          {title && <h3 className="text-sm font-medium text-ink">{title}</h3>}
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {/* overflow-x-auto: a resized (narrower) pane can make wide content
          (data tables especially) wider than the card — scroll it inside
          its own card instead of overflowing the pane. */}
      <div className="overflow-x-auto">{children}</div>
      {methodology && (
        <div className="px-4 py-2.5">
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="font-mono text-xs text-inkMuted hover:text-ink flex items-center gap-1.5"
          >
            <span aria-hidden>{open ? "▾" : "▸"}</span> Methodology
            <EvidenceTag evidence={methodology.evidence} />
          </button>
          {open && (
            <dl className="mt-2.5 space-y-1.5 text-xs text-inkMuted">
              <div>
                <dt className="font-mono uppercase text-xs text-inkFaint">Formula</dt>
                <dd>{methodology.formula}</dd>
              </div>
              <div>
                <dt className="font-mono uppercase text-xs text-inkFaint">CRS</dt>
                <dd className="font-mono text-xs">{methodology.crs}</dd>
              </div>
              <div>
                <dt className="font-mono uppercase text-xs text-inkFaint">Sources</dt>
                <dd>{methodology.sources.join(" · ")}</dd>
              </div>
              {methodology.caveats && methodology.caveats.length > 0 && (
                <div>
                  <dt className="font-mono uppercase text-xs text-inkFaint">Caveats</dt>
                  <dd>{methodology.caveats.join(" · ")}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </motion.div>
  );
}

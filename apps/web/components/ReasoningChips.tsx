"use client";

/**
 * Chip lifecycle (§6c.2): pending (hollow dot) → active (pulsing dot,
 * primary border) → done (teal check). Failure turns the active chip amber —
 * the scalpel's one legitimate UI use (§6c.5). Chips resolve, not just append.
 * Shape is `sm` radius, not `rounded-full` — pills are reserved for round map
 * toggles (§1.4); these read as small stamps, kin to the evidence tags they
 * sit beside. Includes the mono elapsed-ms ticker (§6c.4): instruments show
 * their readings.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { motionTokens } from "@/lib/tokens";

export type ChipState = "active" | "done" | "failed";
export interface Chip {
  step: string;
  state: ChipState;
}

function Dot({ state, reduced }: { state: ChipState; reduced: boolean }) {
  if (state === "done")
    return (
      <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 text-primary" aria-hidden>
        <path d="M1.5 5.5 4 8l4.5-6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (state === "failed")
    return <span className="w-2 h-2 rounded-full bg-alert" aria-hidden />;
  return (
    <motion.span
      className="w-2 h-2 rounded-full bg-primary"
      animate={reduced ? undefined : { opacity: [1, 0.35, 1] }}
      transition={reduced ? undefined : { duration: 1.1, repeat: Infinity }}
      aria-hidden
    />
  );
}

export function ReasoningChips({
  chips,
  startedAt,
  doneMs,
  failedMessage,
  onRetry,
}: {
  chips: Chip[];
  startedAt: number | null;
  doneMs: number | null;
  failedMessage?: string | null;
  onRetry?: () => void;
}) {
  const reduced = !!useReducedMotion();
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (startedAt === null || doneMs !== null) return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [startedAt, doneMs]);

  const elapsed =
    doneMs ?? (startedAt !== null ? Math.max(0, Math.round(now - startedAt)) : null);

  if (chips.length === 0 && elapsed === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="status" aria-live="polite">
      <AnimatePresence>
        {chips.map((c) => (
          <motion.span
            key={c.step}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: -10 }}
            transition={motionTokens.spring}
            className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs bg-sheet ${
              c.state === "active"
                ? "border-primary text-ink"
                : c.state === "failed"
                  ? "border-alert text-alertInk"
                  : "border-border text-inkMuted"
            }`}
          >
            <Dot state={c.state} reduced={reduced} />
            {c.step}
          </motion.span>
        ))}
      </AnimatePresence>

      {elapsed !== null && (
        <span className="font-mono text-xs text-inkFaint tabular-nums ml-1">
          {elapsed.toLocaleString("en-IN")} ms
        </span>
      )}

      {failedMessage && (
        <motion.div
          initial={reduced ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={motionTokens.spring}
          className="w-full mt-1.5 rounded-md border border-alert bg-sheet px-3 py-2 text-sm text-alertInk flex items-center justify-between gap-3"
          role="alert"
        >
          <span>{failedMessage}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              className="shrink-0 rounded-sm border border-alert px-2 py-0.5 text-xs font-mono font-medium hover:bg-alert/10 transition-colors"
            >
              Retry
            </button>
          )}
        </motion.div>
      )}
    </div>
  );
}

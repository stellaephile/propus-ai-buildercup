"use client";

/**
 * Slim celestial top bar (§8). Shares layoutIds with the landing nav so the
 * zero-cut entry morphs one into the other (§6d). The chat-pane show/hide
 * control now lives on the pane's own edge (see ChatPaneToggle), not here.
 */

import { motion, useReducedMotion } from "framer-motion";
import { motionTokens } from "@/lib/tokens";
import { ThemeToggle } from "./ThemeToggle";

export function TopBar({ mode }: { mode: "demo" | "live" }) {
  const reduced = useReducedMotion();
  return (
    <motion.header
      layoutId="propus-nav"
      transition={reduced ? { duration: 0 } : motionTokens.spring}
      className="h-12 shrink-0 bg-celestial text-onCelestial flex items-center justify-between px-4"
    >
      <div className="flex items-baseline gap-3">
        <motion.span layoutId="propus-wordmark" className="font-serif text-lg leading-none">
          Propus AI
        </motion.span>
        <span className="text-xs text-onCelestialMuted hidden sm:inline">
          Delhi transit intelligence
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span
          className="font-mono text-xs uppercase tracking-wide border border-onCelestialMuted/50 text-onCelestialMuted rounded px-1.5 py-0.5"
          title={
            mode === "demo"
              ? "Recorded/fixture streams — a model outage cannot kill this demo"
              : "Live agent"
          }
        >
          {mode}
        </span>
        <ThemeToggle className="text-onCelestialMuted hover:text-onCelestial" />
        {/* plain anchor, not next/link — keeps the DS component free of the
            Next client runtime (design-sync bundles it standalone) */}
        <a
          href="/kit"
          className="font-mono text-xs text-onCelestialMuted hover:text-onCelestial"
        >
          /kit
        </a>
      </div>
    </motion.header>
  );
}

"use client";

/**
 * StartupScreen — the title card that covers the Render cold start (§5).
 *
 * Deliberately bare: the backdrop plays full-bleed and the only chrome is a
 * loading percentage in the bottom-right corner. No mark, no wordmark, no
 * status prose — the one exception is the failure line, which earns its place
 * because a demo that has silently given up looks broken (§6c.5).
 *
 * The card is a SEPARATE SHOT from the Observatory: it swipes away before any
 * real geometry is on screen, so nothing decorative can be mistaken for
 * analysis output (§3.1 / §12).
 */

import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import { useEffect } from "react";
import { SplashBackdrop } from "@/components/startup/SplashBackdrop";
import { colors, motionTokens, splashTokens, type } from "@/lib/tokens";
import type { WarmupStatus } from "@/lib/useApiWarmup";

/** spoken to screen readers; only the failure case is ever drawn */
const READOUT: Record<WarmupStatus, string> = {
  connecting: "connecting to analysis service",
  waking: "waking analysis service — free tier cold start",
  ready: "ready",
  degraded: "service unreachable — continuing with demo data",
};

interface Props {
  status: WarmupStatus;
  elapsedMs: number;
  leaving: boolean;
  onSkip: () => void;
}

export function StartupScreen({ status, elapsedMs, leaving, onSkip }: Props) {
  const reduced = !!useReducedMotion();
  const failed = status === "degraded";
  const done = status === "ready";

  /**
   * The percentage, driven by real warmup state rather than a fixed tick. The
   * reference component counts 1→100 on an 18ms timer no matter what the
   * backend is doing; a number that claims progress it has not measured is
   * exactly what §6c.4 forbids. This one reads elapsed against the patience
   * budget, holds at 99 while genuinely waiting, and reaches 100 only when
   * /health actually answers.
   */
  const pct = useMotionValue(0);
  const shown = useTransform(pct, (v) => Math.round(v));
  useEffect(() => {
    if (done) {
      // §6b beat 5: the number counts up to its true value on resolve
      const c = animate(pct, 100, motionTokens.springSoft);
      return () => c.stop();
    }
    if (failed) return; // freeze wherever it got to — the reading stands
    pct.set(Math.min(99, (100 * elapsedMs) / splashTokens.maxMs));
  }, [elapsedMs, done, failed, pct]);

  // Escape still skips into demo mode even though nothing advertises it —
  // the visible affordance was cut, the escape hatch was not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Propus AI starting. ${READOUT[status]}.`}
      className="fixed inset-0 z-[9500]"
      onClick={onSkip}
      style={{
        backgroundColor: colors.celestial,
        // Swipe-up reveal (the reference component's signature exit): the card
        // lifts off the app rather than dissolving into it. Kept in CSS so it
        // stays on the compositor and cannot stall behind MapLibre's init.
        opacity: leaving ? 0 : 1,
        transform: leaving && !reduced ? "translateY(-100%)" : "translateY(0)",
        transition: reduced
          ? "opacity 0s"
          : `transform ${motionTokens.dur.slow}s ${splashTokens.exitEase}, opacity ${motionTokens.dur.slow}s ${splashTokens.exitEase}`,
        pointerEvents: leaving ? "none" : "auto",
        willChange: "opacity, transform",
      }}
    >
      <SplashBackdrop />

      {/* the only chrome: the reading, bottom right */}
      <motion.div
        className="absolute bottom-8 right-8 flex items-baseline gap-1 tabular-nums sm:bottom-10 sm:right-12"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...motionTokens.spring, delay: reduced ? 0 : 0.2 }}
        style={{ fontFamily: type.mono }}
      >
        <motion.span
          className="text-5xl leading-none sm:text-6xl"
          style={{ color: failed ? colors.alertInk : colors.onCelestial }}
        >
          {shown}
        </motion.span>
        <span
          className="text-xl"
          style={{ color: failed ? colors.alertInk : colors.onCelestialMuted }}
        >
          %
        </span>
      </motion.div>

      {/* failure is the one state that still speaks: a frozen number with no
          explanation reads as a hung app, not as a handled fallback */}
      {failed && (
        <motion.p
          className="absolute bottom-8 left-8 max-w-[30ch] text-[12px] uppercase leading-relaxed tracking-[0.14em] sm:bottom-12 sm:left-12"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: motionTokens.dur.base }}
          style={{ fontFamily: type.mono, color: colors.alertInk }}
        >
          {READOUT.degraded}
        </motion.p>
      )}
    </div>
  );
}

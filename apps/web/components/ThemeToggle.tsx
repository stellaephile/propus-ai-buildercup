"use client";

/**
 * Light ⇄ Night-Chart toggle (§7). A deliberate, persisted instrument setting —
 * so it's an explicit control, not an OS follow. Keyboard-navigable, labelled,
 * and inherits the global focus ring.
 *
 * A classic sliding-track switch: the knob physically shifts left (light) /
 * right (dark), carrying a sun/moon icon that crossfades mid-slide. The slide
 * is a plain CSS transition on `transform`, not a framer-motion spring — in
 * testing, a framer `animate={{ x }}` on this knob would occasionally stop
 * tracking prop updates after the theme flipped via the persisted-choice
 * reconciliation effect (rather than a direct click), landing on a stale
 * position even though every plain-React attribute on the same element
 * (aria-checked, aria-label) was already correct. Rather than chase that
 * down, the slide uses the same fix as `ChatPaneToggle`'s edge handle: let
 * the browser's own transition engine own the position, and keep
 * framer-motion for what it's reliably driving here — the icon crossfade
 * (`AnimatePresence`) below, on `motionTokens.spring`.
 *
 * Track/knob colors are plain tokens (`border`, `sheet`, `primary`) — correct
 * in both themes for free. The one deliberate exception is the sun glyph:
 * `text-primary` read at only ~2.4:1 against the dark-theme knob (`sheet` ==
 * `#1B3048` when the sun is showing, i.e. theme already flipped to dark) —
 * under WCAG 1.4.11's 3:1 floor for a graphical icon. `#D4A017` (a muted
 * gold, not the reserved `alert` amber `#d4853a` — that stays scalpel-only
 * for underserved-data callouts per §3.4) checks in at 5.7:1 on that same
 * knob, comfortably past AA, and reads as the conventional "sun" color
 * besides. Moon stays on `primary` (8.3:1 on the light knob — already fine).
 */

import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useTheme } from "@/lib/theme";
import { motionTokens } from "@/lib/tokens";

const TRACK_W = 44;
const TRACK_H = 24;
const KNOB = 18;
const PAD = 3;
const KNOB_X_LIGHT = PAD;
const KNOB_X_DARK = TRACK_W - KNOB - PAD;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const reduced = useReducedMotion();
  const dark = theme === "dark";
  const transition = reduced ? { duration: 0 } : motionTokens.spring;

  return (
    <button
      type="button"
      onClick={toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode (Night Chart)"}
      className={`relative inline-flex shrink-0 items-center rounded-full ${className ?? ""}`}
      style={{
        width: TRACK_W,
        height: TRACK_H,
        background: "color-mix(in srgb, currentColor 12%, transparent)",
        border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
      }}
    >
      <span
        aria-hidden
        className="absolute flex items-center justify-center rounded-full bg-sheet shadow-ambient transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{
          width: KNOB,
          height: KNOB,
          top: (TRACK_H - KNOB) / 2,
          transform: `translateX(${dark ? KNOB_X_DARK : KNOB_X_LIGHT}px)`,
        }}
      >
        <span className="relative h-3 w-3">
          <AnimatePresence initial={false} mode="wait">
            {dark ? (
              <motion.svg
                key="sun"
                viewBox="0 0 24 24"
                className="absolute inset-0 h-3 w-3 text-[#D4A017]"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                aria-hidden
                initial={reduced ? false : { opacity: 0, rotate: -45 }}
                animate={{ opacity: 1, rotate: 0 }}
                exit={reduced ? undefined : { opacity: 0, rotate: 45 }}
                transition={transition}
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </motion.svg>
            ) : (
              <motion.svg
                key="moon"
                viewBox="0 0 24 24"
                className="absolute inset-0 h-3 w-3 text-primary"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                initial={reduced ? false : { opacity: 0, rotate: 45 }}
                animate={{ opacity: 1, rotate: 0 }}
                exit={reduced ? undefined : { opacity: 0, rotate: -45 }}
                transition={transition}
              >
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </motion.svg>
            )}
          </AnimatePresence>
        </span>
      </span>
    </button>
  );
}

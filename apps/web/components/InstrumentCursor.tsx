"use client";

/**
 * InstrumentCursor — the surveyor's reticle. The app is an instrument, so the
 * pointer is one too: a precise ink dot rides the pointer 1:1 (no lag — lag
 * reads as imprecision), while a halo ring settles behind it on springSoft.
 * Over interactive elements the ring widens; over the map it gains crosshair
 * ticks; on press it contracts. Text fields hide the reticle and return the
 * native I-beam. Fine pointers only; under prefers-reduced-motion the halo
 * tracks rigidly and every state change snaps. No amber, no ambient loops.
 */

import { useEffect, useState } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from "framer-motion";
import { motionTokens } from "@/lib/tokens";
import { useThemePalette } from "@/lib/theme";

type CursorMode = "default" | "interactive" | "map" | "text";

const TEXT_SEL =
  'textarea, [contenteditable="true"], ' +
  'input:not([type]), input[type="text"], input[type="search"], ' +
  'input[type="email"], input[type="url"], input[type="number"], ' +
  'input[type="password"]';
const INTERACTIVE_SEL =
  'a, button, [role="button"], select, summary, label, ' +
  'input[type="range"], input[type="checkbox"], input[type="radio"], ' +
  'input[type="submit"], input[type="button"], ' +
  '.cursor-pointer, [data-cursor="interactive"]';
const MAP_SEL =
  '.maplibregl-canvas-container, .maplibregl-canvas, [data-cursor="map"]';

function modeFor(target: EventTarget | null): CursorMode {
  if (!(target instanceof Element)) return "default";
  if (target.closest(TEXT_SEL)) return "text";
  if (target.closest(INTERACTIVE_SEL)) return "interactive";
  if (target.closest(MAP_SEL)) return "map";
  return "default";
}

export function InstrumentCursor() {
  const reduced = useReducedMotion();
  const { palette: colors } = useThemePalette();
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [mode, setMode] = useState<CursorMode>("default");

  const mx = useMotionValue(-100);
  const my = useMotionValue(-100);
  const hx = useSpring(mx, motionTokens.springSoft);
  const hy = useSpring(my, motionTokens.springSoft);
  // Reduced motion: the halo tracks 1:1 instead of settling on the spring.
  const haloX = reduced ? mx : hx;
  const haloY = reduced ? my : hy;

  useEffect(() => {
    const mq = window.matchMedia("(pointer: fine)");
    const update = () => setEnabled(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    document.documentElement.classList.add("instrument-cursor");

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      mx.set(e.clientX);
      my.set(e.clientY);
      setVisible(true);
    };
    const onOver = (e: PointerEvent) => setMode(modeFor(e.target));
    const onDown = () => setPressed(true);
    const onUp = () => setPressed(false);
    const onLeave = () => setVisible(false);

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerover", onOver, { passive: true });
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    document.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      document.documentElement.classList.remove("instrument-cursor");
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [enabled, mx, my]);

  if (!enabled) return null;

  const shown = visible && mode !== "text";
  const snap = reduced ? { duration: 0 } : motionTokens.spring;
  const haloScale = pressed ? 0.85 : mode === "interactive" ? 1.4 : 1;

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[9999]">
      {/* halo ring — settles behind the dot on springSoft */}
      <motion.div
        className="absolute left-0 top-0"
        style={{ x: haloX, y: haloY }}
      >
        <motion.div
          // centered via negative margins — framer's scale transform would
          // overwrite a translate class on this element. border-2 = thicker
          // aim ring; bright cyan `cursor` token reads on both basemaps/themes.
          className="absolute -ml-4 -mt-4 h-8 w-8 rounded-full border-2"
          animate={{
            scale: haloScale,
            opacity: shown ? 1 : 0,
            // hex + alpha channel: cc ≈ 80% — resting halo is a touch softer
            borderColor:
              mode === "interactive" ? colors.cursor : `${colors.cursor}cc`,
          }}
          transition={snap}
        >
          {/* crosshair ticks — the reticle reads the map (§ instrument) */}
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <motion.span
              key={side}
              style={{ background: colors.cursor }}
              className={
                "absolute " +
                (side === "top"
                  ? "left-1/2 top-[-7px] h-[6px] w-px -translate-x-1/2"
                  : side === "bottom"
                    ? "bottom-[-7px] left-1/2 h-[6px] w-px -translate-x-1/2"
                    : side === "left"
                      ? "left-[-7px] top-1/2 h-px w-[6px] -translate-y-1/2"
                      : "right-[-7px] top-1/2 h-px w-[6px] -translate-y-1/2")
              }
              animate={{ opacity: mode === "map" ? 1 : 0 }}
              transition={snap}
            />
          ))}
        </motion.div>
      </motion.div>

      {/* ink dot — rides the pointer exactly; the instrument is precise */}
      <motion.div className="absolute left-0 top-0" style={{ x: mx, y: my }}>
        <motion.div
          // `ink` (theme-aware) not `celestial` — the centre dot now flips
          // dark↔light with the theme so it stays visible in dark mode too
          className="absolute -ml-[3px] -mt-[3px] h-1.5 w-1.5 rounded-full"
          style={{ background: colors.ink }}
          animate={{
            scale: mode === "interactive" ? 0.6 : 1,
            opacity: shown ? 1 : 0,
          }}
          transition={snap}
        />
      </motion.div>
    </div>
  );
}

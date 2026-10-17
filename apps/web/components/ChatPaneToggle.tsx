"use client";

/**
 * Chat-pane edge handle — a round button that straddles the boundary
 * between the chat pane and the map (VS Code-sidebar convention), sliding
 * between the pane's right edge (38% default, §8, user-resizable) and the
 * viewport's left edge when the pane is hidden. The chevron flips to match.
 *
 * Single control, two behaviours, disambiguated by movement (VS Code's own
 * sidebar handle works the same way):
 *   - A plain click (pointer never moves past DRAG_THRESHOLD_PX) toggles
 *     show/hide.
 *   - A drag resizes the pane live, following the pointer 1:1.
 * ArrowLeft/ArrowRight resize in fixed steps when focused, so resizing stays
 * keyboard-reachable even though the drag itself is pointer-only (CLAUDE.md
 * §3.7 — full keyboard nav is a hard rule).
 *
 * The slide itself is a plain CSS transition on `left`, not a framer-motion
 * spring: framer-motion animates transforms (x/y/scale/rotate) by driving
 * them straight to a numeric pixel target every frame — animating a *layout*
 * property like `left` against a percentage string has no stable pixel
 * reference to converge on, so a spring on it settles at an arbitrary
 * intermediate value instead of the real endpoint. The browser's own
 * transition engine has no such problem (it recomputes the percentage
 * natively each frame), so that's what drives the slide — except mid-drag,
 * where the transition is dropped so the button tracks the pointer instead
 * of easing 300ms behind it. Framer-motion still drives what it's built
 * for — the chevron's spring-based flip and the tap feedback — per
 * `motionTokens` (never an inline spring config).
 *
 * Colors are plain tokens (`sheet`/`border`/`inkMuted`), so it's correct in
 * both themes for free — no bespoke light/dark handling needed.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useRef, useState } from "react";
import { motionTokens, spacing } from "@/lib/tokens";

const DRAG_THRESHOLD_PX = 4;
const KEY_STEP_PCT = 2;

export function ChatPaneToggle({
  visible,
  onToggle,
  widthPct = spacing.chatPanePct,
  onResize,
}: {
  visible: boolean;
  onToggle: () => void;
  /** current (possibly user-resized) chat-pane width — see useChatPaneWidth */
  widthPct?: number;
  /** drag callback — omit to make this a pure show/hide toggle */
  onResize?: (pct: number) => void;
}) {
  const reduced = useReducedMotion();
  const transition = reduced ? { duration: 0 } : motionTokens.spring;

  const [dragging, setDragging] = useState(false);
  const movedRef = useRef(false);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  // Listeners are attached synchronously inside the pointerdown handler
  // itself, NOT via a useEffect gated on React state. Gating through state
  // (setDragging(true) → effect commits → THEN attach the listener) leaves a
  // real gap between "the drag started" and "we're actually listening" —
  // any pointermove that lands in that gap is silently dropped. That gap is
  // invisible for a slow human drag but very real for a fast one (verified:
  // it dropped every event during automated testing). Attaching imperatively
  // here closes the gap to zero.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!onResize || !visible) return; // nothing to resize while hidden
      const target = e.target as HTMLElement;
      const pointerId = e.pointerId;
      target.setPointerCapture(pointerId);
      movedRef.current = false;
      setDragging(true);

      const startX = e.clientX;
      const onMove = (ev: PointerEvent) => {
        if (!movedRef.current && Math.abs(ev.clientX - startX) > DRAG_THRESHOLD_PX) {
          movedRef.current = true;
        }
        if (movedRef.current) {
          onResizeRef.current?.((ev.clientX / window.innerWidth) * 100);
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
        setDragging(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onResize, visible]
  );

  const onClick = useCallback(() => {
    if (movedRef.current) {
      // suppress the click that follows a real drag's pointerup
      movedRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!onResize || !visible) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onResize(widthPct - KEY_STEP_PCT);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onResize(widthPct + KEY_STEP_PCT);
      }
    },
    [onResize, visible, widthPct]
  );

  return (
    <motion.button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="switch"
      aria-checked={visible}
      aria-label={visible ? "Hide chat pane (drag to resize)" : "Show chat pane"}
      title={visible ? "Hide chat · drag to resize" : "Show chat"}
      className={`absolute z-10 flex h-8 w-8 items-center justify-center rounded-full bg-sheet border border-border text-inkMuted hover:text-ink hover:border-borderStrong shadow-ambient ease-out motion-reduce:transition-none touch-none ${
        onResize && visible ? "cursor-col-resize" : ""
      } ${dragging ? "" : "transition-[left] duration-300"}`}
      style={{ left: visible ? `${widthPct}%` : "0%", top: "50%", x: "-50%", y: "-50%" }}
      whileTap={reduced || dragging ? undefined : { scale: 0.9 }}
    >
      <motion.svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        animate={{ rotate: visible ? 0 : 180 }}
        transition={transition}
      >
        <path d="M15 6l-6 6 6 6" />
      </motion.svg>
    </motion.button>
  );
}

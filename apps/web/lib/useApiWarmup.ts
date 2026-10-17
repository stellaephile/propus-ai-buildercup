"use client";

/**
 * useApiWarmup — gates the startup screen (components/startup/StartupScreen).
 *
 * The cold start in this stack is Render, not Vercel: the frontend paints fast
 * and the FastAPI service is asleep (CLAUDE.md §5). So the card is dismissed by
 * a REAL /health answer, not a timer — with a floor so it never flashes and a
 * ceiling so a dead backend can't hold the pitch hostage.
 *
 * Shown once per browser session (sessionStorage); a refresh mid-demo goes
 * straight to the Observatory.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motionTokens, splashTokens } from "@/lib/tokens";

const SESSION_KEY = "propus:splash-seen";

/** connecting → waking → ready | degraded. Rendered verbatim-ish in the readout. */
export type WarmupStatus = "connecting" | "waking" | "ready" | "degraded";

export interface WarmupState {
  /** is the startup card mounted */
  visible: boolean;
  /** card is fading out — drives a CSS opacity transition, not a JS tween.
   *  A full-screen overlay fading while MapLibre initialises starved a Framer
   *  exit animation badly enough that it never settled and the card never
   *  unmounted; a compositor transition cannot stall that way. */
  leaving: boolean;
  status: WarmupStatus;
  /** real elapsed ms since the first probe — the §6c latency-honesty ticker */
  elapsedMs: number;
  /** true once the API answered (or demo mode resolved it locally) */
  warm: boolean;
  /** user pressed Escape / clicked skip — enters demo mode without waiting */
  dismiss: () => void;
}

function sessionSeen(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return false; // private mode / blocked storage: just show it
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    /* non-fatal */
  }
}

export function useApiWarmup(): WarmupState {
  // start hidden and decide in an effect: sessionStorage is unavailable during
  // SSR, and rendering the card then yanking it would flash on every refresh
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [status, setStatus] = useState<WarmupStatus>("connecting");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [warm, setWarm] = useState(false);
  const startedAt = useRef(0);
  const closed = useRef(false);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    markSeen();
    setLeaving(true);
    // unmount only after the fade has had its full run
    setTimeout(() => setVisible(false), motionTokens.dur.slow * 1000);
  }, []);

  const dismiss = useCallback(() => {
    setStatus((s) => (s === "ready" ? s : "degraded"));
    close();
  }, [close]);

  useEffect(() => {
    if (sessionSeen()) {
      // already shown this session — no card, and nothing to probe for the UI
      setWarm(true);
      setStatus("ready");
      return;
    }

    setVisible(true);
    startedAt.current = performance.now();

    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    const live = process.env.NEXT_PUBLIC_MODE === "live" && !!apiUrl;

    let readyAt: number | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const controllers = new Set<AbortController>();

    /** dismiss no earlier than minMs after mount, so the card never blinks */
    const closeAfterFloor = () => {
      const held = performance.now() - startedAt.current;
      const wait = Math.max(0, splashTokens.minMs - held);
      timers.push(setTimeout(close, wait));
    };

    // elapsed ticker — real reading, frozen the moment we go ready/degraded
    const tick = setInterval(() => {
      if (readyAt !== null) return;
      setElapsedMs(Math.round(performance.now() - startedAt.current));
    }, 100);

    // demo mode needs no backend (CLAUDE.md §5.2) — resolve locally, hold the floor
    if (!live) {
      readyAt = performance.now();
      setElapsedMs(0);
      setWarm(true);
      setStatus("ready");
      closeAfterFloor();
      return () => {
        clearInterval(tick);
        timers.forEach(clearTimeout);
      };
    }

    const markReady = () => {
      if (readyAt !== null) return;
      readyAt = performance.now();
      setElapsedMs(Math.round(readyAt - startedAt.current));
      setWarm(true);
      setStatus("ready");
      closeAfterFloor();
    };

    const probe = async () => {
      if (readyAt !== null || closed.current) return;
      const ctrl = new AbortController();
      controllers.add(ctrl);
      // don't let one hung socket stall the chain — each probe is disposable
      const kill = setTimeout(() => ctrl.abort(), splashTokens.pollMs * 2);
      try {
        const res = await fetch(`${apiUrl}/health`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (res.ok) markReady();
      } catch {
        /* asleep, or not reachable yet — the next probe decides */
      } finally {
        clearTimeout(kill);
        controllers.delete(ctrl);
      }
      if (readyAt === null && !closed.current) {
        timers.push(setTimeout(probe, splashTokens.pollMs));
      }
    };
    void probe();

    // no answer yet → say so plainly rather than sitting on "connecting"
    timers.push(
      setTimeout(() => {
        if (readyAt === null) setStatus("waking");
      }, splashTokens.warmingAfterMs)
    );

    // ceiling: enter the app in demo mode and be honest about why
    timers.push(
      setTimeout(() => {
        if (readyAt === null) {
          setStatus("degraded");
          // let the message land for a beat before cutting away
          timers.push(setTimeout(close, 1400));
        }
      }, splashTokens.maxMs)
    );

    return () => {
      clearInterval(tick);
      timers.forEach(clearTimeout);
      controllers.forEach((c) => c.abort());
    };
  }, [close]);

  return { visible, leaving, status, elapsedMs, warm, dismiss };
}

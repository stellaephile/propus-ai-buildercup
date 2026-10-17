"use client";

/**
 * Persisted, user-resizable chat-pane width (CLAUDE.md §8's 38/62 split is
 * the default, not a wall). Same localStorage-persistence shape as
 * lib/theme.tsx's ThemeProvider — one source of truth, session-durable,
 * fails soft (private browsing / storage disabled) back to the default.
 */

import { useCallback, useEffect, useState } from "react";
import { spacing } from "./tokens";

const STORAGE_KEY = "propus-chat-pane-pct";

function clamp(pct: number): number {
  return Math.min(spacing.chatPaneMaxPct, Math.max(spacing.chatPaneMinPct, pct));
}

export function useChatPaneWidth(): {
  widthPct: number;
  setWidthPct: (pct: number) => void;
} {
  const [widthPct, setWidthPctState] = useState<number>(spacing.chatPanePct);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const n = stored ? Number(stored) : NaN;
      if (Number.isFinite(n)) setWidthPctState(clamp(n));
    } catch {
      /* storage unavailable — session-only default width */
    }
  }, []);

  const setWidthPct = useCallback((pct: number) => {
    const clamped = clamp(pct);
    setWidthPctState(clamped);
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped));
    } catch {
      /* storage unavailable — width just won't persist across sessions */
    }
  }, []);

  return { widthPct, setWidthPct };
}

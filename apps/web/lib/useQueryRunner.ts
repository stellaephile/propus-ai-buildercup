"use client";

/**
 * The query state machine — consumes the typed event stream (demo replay or
 * live SSE) and drives chips, skeletons, results, and the map choreography.
 * Chip lifecycle per §6c.2; chips exit together on the first result (§6b.1).
 */

import { useCallback, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import type { Methodology, PropusResult, ResultKind } from "@propus/contract";
import type { Chip } from "@/components/ReasoningChips";
import {
  buildCatchment,
  buildComparison,
  buildDensityRank,
  buildScenario,
  buildUnknown,
  buildWorstWards,
  classify,
  type QueryIntent,
} from "./demo/queries";
import { APP_MODE } from "./mode";
import { buildRecorded } from "./demo/recorded";
import { liveWithFallback, replay } from "./demo/stream";
import type { StopsData } from "./data/useStopsData";

export interface RenderedResult {
  payload: PropusResult;
  methodology?: Methodology;
}

/** A completed prior turn, archived so evidence accumulates (§8.1 Scene 5). */
export interface ArchivedTurn {
  query: string;
  results: RenderedResult[];
  doneMs: number | null;
  mode: "demo" | "live";
}

export interface RunnerState {
  status: "idle" | "running" | "done" | "error";
  query: string | null;
  intent: QueryIntent;
  plan: ResultKind[];
  chips: Chip[];
  results: RenderedResult[];
  history: ArchivedTurn[];
  notices: string[];
  startedAt: number | null;
  doneMs: number | null;
  mode: "demo" | "live";
  error: string | null;
}

const idle: RunnerState = {
  status: "idle",
  query: null,
  intent: "unknown",
  plan: [],
  chips: [],
  results: [],
  history: [],
  notices: [],
  startedAt: null,
  doneMs: null,
  mode: "demo",
  error: null,
};

export function useQueryRunner({
  stops,
  wards,
  scenarioPoint,
  onMapLayer,
  onQueryStart,
}: {
  stops: StopsData;
  wards: GeoJSON.FeatureCollection | null;
  scenarioPoint: [number, number] | null;
  onMapLayer: (
    result: Extract<PropusResult, { kind: "map_layer" }>,
    intent: QueryIntent
  ) => void;
  /** Fired once, synchronously, at the top of every run() — before this
   *  query's own map_layer results start arriving. The map keeps a layer
   *  from every past turn (so the Layer Manager can toggle history back on),
   *  but a NEW turn's own result should be the only one lit by default —
   *  otherwise a second query just piles its buffer/choropleth on top of the
   *  last one and the map reads as noise. page.tsx uses this to turn the
   *  previous turn's layers off (not remove them) before this turn adds its
   *  own, visible ones. */
  onQueryStart?: () => void;
}) {
  const [state, setState] = useState<RunnerState>(idle);
  const reduced = !!useReducedMotion();
  const runSeq = useRef(0);
  const lastQuery = useRef<string | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (query: string) => {
      // A double-click or a repeated Enter must not send the same question twice.
      // (Scenario questions re-run on purpose when a point is picked on the map.)
      if (busy.current && lastQuery.current === query && classify(query) !== "scenario") return;
      onQueryStart?.();
      const seq = ++runSeq.current;
      lastQuery.current = query;
      busy.current = true;
      // A newer question cancels the one still in flight, so the server stops
      // working on an answer nobody will read.
      inflight.current?.abort();
      const ac = new AbortController();
      inflight.current = ac;
      const intent = classify(query);
      const mode = APP_MODE;

      const built =
        intent === "worst_wards"
          ? buildWorstWards(wards)
          : intent === "comparison"
            ? buildComparison(wards)
            : intent === "catchment"
              ? buildCatchment(stops)
              : intent === "density_rank"
                ? buildDensityRank()
                : intent === "scenario"
                  ? buildScenario(stops, scenarioPoint, 800)
                  : intent === "heat" || intent === "coverage_gap" || intent === "refusal"
                    ? buildRecorded(intent)
                    : buildUnknown();


      // Archive the prior turn's cards before resetting so evidence accumulates
      // rather than being silently replaced (§8.1 Scene 5, BUGS.md B3).
      setState((prev) => {
        const history =
          prev.query && prev.results.length
            ? [
                ...prev.history,
                {
                  query: prev.query,
                  results: prev.results,
                  doneMs: prev.doneMs,
                  mode: prev.mode,
                },
              ]
            : prev.history;
        return {
          ...idle,
          history,
          status: "running",
          query,
          intent,
          mode,
          startedAt: performance.now(),
          // Optimistic: show the answer's silhouette and a first chip at once,
          // so a slow or cold backend never leaves a blank pane. The server's
          // own plan and steps replace these as they arrive.
          plan: mode === "live" ? built.results.map((r) => r.payload.kind) : [],
          chips:
            mode === "live"
              ? [{ step: "Sending your question...", state: "active" as const }]
              : [],
        };
      });

      const stream =
        mode === "live"
          ? liveWithFallback(process.env.NEXT_PUBLIC_API_URL as string, query, built, {
              signal: ac.signal,
              reducedMotion: reduced,
            })
          : replay(built, { reducedMotion: reduced });

      let sawResult = false;
      try {
        for await (const ev of stream) {
          if (runSeq.current !== seq) return; // preempted by a newer query
          switch (ev.event) {
            case "plan":
              setState((s) => ({ ...s, plan: ev.kinds }));
              break;
            case "reasoning_step":
              setState((s) => ({
                ...s,
                chips: [
                  ...s.chips.map((c) => ({ ...c, state: "done" as const })),
                  { step: ev.step, state: "active" as const },
                ],
              }));
              break;
            case "result": {
              if (ev.payload.kind === "map_layer") onMapLayer(ev.payload, intent);
              const first = !sawResult;
              sawResult = true;
              setState((s) => ({
                ...s,
                // chips exit together on the first result (§6b beat 1)
                chips: first ? [] : s.chips,
                results: [...s.results, { payload: ev.payload, methodology: ev.methodology }],
              }));
              break;
            }
            case "done":
              setState((s) => ({
                ...s,
                status: "done",
                doneMs: ev.ms,
                mode: ev.mode,
                // built.notices is the demo classifier's copy ("Demo mode answers the five
                // headline queries..."); a live answer must not show it.
                notices: ev.mode === "live" ? [] : built.notices,
                chips: [],
              }));
              break;
            case "error":
              setState((s) => ({
                ...s,
                status: "error",
                error: ev.message,
                // freeze the ms ticker — it only stops once doneMs is set (ReasoningChips)
                doneMs: s.doneMs ?? Math.max(0, Math.round(performance.now() - (s.startedAt ?? performance.now()))),
                chips: s.chips.map((c, i) =>
                  i === s.chips.length - 1 ? { ...c, state: "failed" as const } : c
                ),
              }));
              break;
          }
        }
        // demo streams for scenario-without-point end without results — vellum notices.
        // `built` is always the DEMO classifier's output (it's constructed above
        // regardless of mode), so its notices are only accurate for a demo run —
        // a live run that streamed zero results needs its own, honest message
        // rather than reusing demo copy like "Demo mode answers the five
        // headline queries..." for what was actually a live-agent miss.
        if (runSeq.current === seq && !sawResult) {
          setState((s) =>
            s.status === "error"
              ? s
              : {
                  ...s,
                  status: "done",
                  notices:
                    mode === "live"
                      ? [
                          "The agent didn't return a result for this question — try rephrasing it, or check that the backend is reachable.",
                        ]
                      : built.notices,
                  doneMs: s.doneMs ?? 0,
                }
          );
        }
      } catch (e) {
        if (runSeq.current !== seq) return;
        setState((s) => ({
          ...s,
          status: "error",
          error: e instanceof Error ? e.message : "Stream failed.",
          // freeze the ms ticker — it only stops once doneMs is set (ReasoningChips)
          doneMs: s.doneMs ?? Math.max(0, Math.round(performance.now() - (s.startedAt ?? performance.now()))),
          chips: s.chips.map((c, i) =>
            i === s.chips.length - 1 ? { ...c, state: "failed" as const } : c
          ),
        }));
      } finally {
        if (runSeq.current === seq) busy.current = false;
      }
    },
    [stops, wards, scenarioPoint, onMapLayer, onQueryStart, reduced]
  );

  const retry = useCallback(() => {
    if (lastQuery.current) void run(lastQuery.current);
  }, [run]);

  return { state, run, retry };
}

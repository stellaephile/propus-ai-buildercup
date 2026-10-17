"use client";

/**
 * Left pane (38%): chat + result cards on Vellum (§8). Runs the reveal
 * choreography: chips → shaped skeletons → staggered result cards →
 * (conductor handles the map) → count-ups. Failure grammar per §6c.5.
 */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import { HEADLINE_GISTS, HEADLINE_QUERIES, LIVE_EXAMPLES } from "@/lib/demo/queries";
import { APP_MODE } from "@/lib/mode";
import type { RunnerState } from "@/lib/useQueryRunner";
import type { StopsData } from "@/lib/data/useStopsData";
import { motionTokens, spacing } from "@/lib/tokens";
import { HelpDialog } from "./HelpDialog";
import { QueryInput } from "./QueryInput";
import { ReasoningChips } from "./ReasoningChips";
import { ResultSkeleton } from "./Skeletons";
import { ScenarioPanel } from "./ScenarioPanel";
import { ResultRenderer } from "./results/ResultRenderer";

export function ChatPane({
  state,
  onSubmit,
  onRetry,
  onHoverWard,
  scenarioPoint,
  scenarioSourceId,
  stops,
  mapRef,
  onScenarioCommit,
  widthPct = spacing.chatPanePct,
}: {
  state: RunnerState;
  onSubmit: (q: string) => void;
  onRetry: () => void;
  onHoverWard: (name: string | null) => void;
  scenarioPoint: [number, number] | null;
  scenarioSourceId: string | null;
  stops: StopsData;
  mapRef: React.RefObject<MapRef>;
  onScenarioCommit: (r: number) => void;
  /** current (possibly user-resized) chat-pane width — see useChatPaneWidth */
  widthPct?: number;
}) {
  const reduced = !!useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the stream only while the reader is already near the bottom; a
  // reader who scrolled up to re-read a card must not be dragged back down.
  const followStream = useRef(true);
  useEffect(() => {
    followStream.current = true; // a new question always starts at the bottom
  }, [state.query]);
  useEffect(() => {
    if (!followStream.current) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [state.results.length, state.chips.length, state.notices.length, reduced]);

  const pendingSkeletons =
    state.status === "running" ? state.plan.slice(state.results.length) : [];

  return (
    <main
      aria-label="Questions and results"
      className="flex h-full flex-col bg-vellum border-r border-border min-w-0"
      style={{ width: `${widthPct}%`, minWidth: 380 }}
    >
      {/* min-w-0: flex children default to min-width:auto (their content's
          intrinsic width), which silently blocks shrinking below that even
          when the pane itself narrows — this is what let wide card content
          (e.g. a long stat-card number) overflow instead of reflowing when
          resized. Every result renderer inherits shrinkability from here. */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followStream.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="flex-1 min-w-0 overflow-y-auto px-4 py-4 space-y-3"
      >
        {state.query === null && (
          <div className="pt-6">
            <p className="text-sm text-ink max-w-[44ch]">
              Ask about Delhi&apos;s buses and metro in plain English. Pick an example below or
              type your own question.
            </p>
            <p className="mt-2 text-sm text-inkMuted max-w-[44ch]">
              {APP_MODE === "live"
                ? "Live mode: a language model plans each answer and calls the analysis tools. Every number comes from those tools."
                : "Demo mode: these examples replay recorded answers computed on real data, so they always work. Other questions need live mode."}
            </p>
            <HelpDialog
              label="New here? How to read the results"
              className="-ml-2 mt-1 text-celestialMuted hover:text-celestial"
            />
            {/* An editorial list, not a stack of prompt cards (DESIGN.md §4:
                "Lists: vertical spacing 5 + background shift; never an
                <hr>"). The ▸ glyph echoes the one in QueryInput below. */}
            <ExampleList onSubmit={onSubmit} />
          </div>
        )}

        {/* Archived prior turns — desaturated & compressed; evidence accumulates (§8.1 Scene 5) */}
        {state.history.map((turn, ti) => (
          <div key={`hist-${ti}`} className="space-y-2 opacity-60 saturate-50">
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-sm bg-slate/70 text-ink px-3.5 py-2 text-sm">
                {turn.query}
              </div>
            </div>
            {turn.results.map((r, i) => (
              <ResultRenderer
                key={`hist-${ti}-${i}`}
                result={r.payload}
                methodology={r.methodology}
                onHoverRow={onHoverWard}
              />
            ))}
          </div>
        ))}

        {state.query && (
          <div className="flex justify-end">
            {/* U3: user bubble = slate on warm paper, sm radius — a cool input, not heavy navy */}
            <div className="max-w-[85%] rounded-sm bg-slate text-ink px-3.5 py-2 text-sm">
              {state.query}
            </div>
          </div>
        )}

        <ReasoningChips
          chips={state.chips}
          startedAt={state.startedAt}
          doneMs={state.doneMs}
          failedMessage={state.status === "error" ? state.error : null}
          onRetry={onRetry}
        />

        <AnimatePresence mode="popLayout">
          {state.results.map((r, i) => (
            <motion.div
              key={`${state.query}-${i}`}
              initial={reduced ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={motionTokens.spring}
            >
              <ResultRenderer
                result={r.payload}
                methodology={r.methodology}
                onHoverRow={onHoverWard}
              />
            </motion.div>
          ))}
          {pendingSkeletons.map((kind, i) => (
            <ResultSkeleton key={`sk-${state.query}-${state.results.length + i}`} kind={kind} />
          ))}
        </AnimatePresence>

        {state.intent === "scenario" && state.status !== "idle" && (
          <ScenarioPanel
            point={scenarioPoint}
            stops={stops}
            mapRef={mapRef}
            sourceId={scenarioSourceId ?? "res-none"}
            onCommit={onScenarioCommit}
          />
        )}

        {state.notices.map((n) => (
          <p
            key={n}
            className="rounded-md bg-sheet px-3 py-2 text-xs text-inkMuted"
          >
            {n}
          </p>
        ))}

        {(state.status === "done" || state.status === "error") && (
          <details className="rounded-md bg-sheet px-3 py-2 text-sm">
            <summary className="cursor-pointer min-h-[32px] py-1 text-celestialMuted hover:text-celestial">
              More questions to try
            </summary>
            <ExampleList onSubmit={onSubmit} />
          </details>
        )}

        {state.status === "done" && state.doneMs !== null && (
          <p className="font-mono text-xs text-inkFaint text-right tabular-nums">
            {state.doneMs.toLocaleString("en-IN")} ms · mode: {state.mode}
          </p>
        )}
      </div>

      {/* Tonal dock, not a ruled-off toolbar (No-Line Rule, DESIGN.md §1.4) —
          vellumShade sits between the vellum pane and the vellumDeep input
          pill, a small three-step sink instead of a line. */}
      <div className="shrink-0 bg-vellumShade/60 px-4 py-3">
        <QueryInput onSubmit={onSubmit} disabled={state.status === "running"} />
      </div>
    </main>
  );
}

function ExampleButton({
  q,
  gist,
  onSubmit,
}: {
  q: string;
  gist: string;
  onSubmit: (q: string) => void;
}) {
  return (
    <button
      onClick={() => onSubmit(q)}
      className="group flex min-h-[44px] items-start gap-2 rounded-sm px-2 py-2 text-left text-sm text-celestialMuted hover:bg-vellumShade hover:text-celestial"
    >
      <span className="font-mono text-primary" aria-hidden>
        ▸
      </span>
      <span>
        <span className="block">{q}</span>
        <span className="mt-0.5 block text-xs text-inkMuted">{gist}</span>
      </span>
    </button>
  );
}

function ExampleList({ onSubmit }: { onSubmit: (q: string) => void }) {
  return (
    <>
      <h2 className="mt-3 font-mono text-xs uppercase tracking-wide text-inkMuted">
        Transit access
      </h2>
      <div className="mt-1 flex flex-col">
        {HEADLINE_QUERIES.map((q) => (
          <ExampleButton key={q} q={q} gist={HEADLINE_GISTS[q]} onSubmit={onSubmit} />
        ))}
      </div>
      {APP_MODE === "live" && (
        <>
          <h2 className="mt-4 font-mono text-xs uppercase tracking-wide text-inkMuted">
            Heat and who is left out
          </h2>
          <div className="mt-1 flex flex-col">
            {LIVE_EXAMPLES.map((e) => (
              <ExampleButton key={e.q} q={e.q} gist={e.gist} onSubmit={onSubmit} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

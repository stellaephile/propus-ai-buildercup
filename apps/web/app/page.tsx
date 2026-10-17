"use client";

/**
 * Propus — one continuous shot from landing to answer (§6d "zero-cut entry").
 * The MapLibre instance is shared between the landing hero and the app: it
 * mounts once and never remounts. On submit, the nav condenses, the input
 * morphs (layoutId), the chat pane slides in, and the camera flies straight
 * into the answer choreography.
 */

import { LayoutGroup, motion, useReducedMotion, animate } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { PropusResult } from "@propus/contract";
import { ChatPane } from "@/components/ChatPane";
import { ChatPaneToggle } from "@/components/ChatPaneToggle";
import { HelpDialog } from "@/components/HelpDialog";
import { landingExamples } from "@/lib/demo/queries";
import { QueryInput } from "@/components/QueryInput";
import { TopBar } from "@/components/TopBar";
import { ProofStrip } from "@/components/landing/ProofStrip";
import { StartupScreen } from "@/components/startup/StartupScreen";
import { LayerManager } from "@/components/map/LayerManager";
import { MapView, type BaseLayerState, type ResultLayer } from "@/components/map/MapView";
import { busStopsSampleGeoJSON } from "@/lib/data/busStopsSample";
import { metroStopsGeoJSON } from "@/lib/data/metroStops";
import { useCityBoundary, useMetroLines, useStopsData, useWards } from "@/lib/data/useStopsData";
import { circlePolygon } from "@/lib/geo";
import { useMapConductor } from "@/lib/map/useMapConductor";
import { motionTokens } from "@/lib/tokens";
import { useThemePalette } from "@/lib/theme";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useQueryRunner } from "@/lib/useQueryRunner";
import { useApiWarmup } from "@/lib/useApiWarmup";
import { useChatPaneWidth } from "@/lib/useChatPaneWidth";
import type { QueryIntent } from "@/lib/demo/queries";

export default function Page() {
  const reduced = !!useReducedMotion();
  const { palette } = useThemePalette();
  const [phase, setPhase] = useState<"landing" | "app">("landing");
  // covers the Render cold start; dismissed by a live /health answer (§5)
  const warmup = useApiWarmup();
  const [chatVisible, setChatVisible] = useState(true);
  const { widthPct: chatPaneWidthPct, setWidthPct: setChatPaneWidthPct } = useChatPaneWidth();
  const [twinkleProgress, setTwinkleProgress] = useState(reduced ? 1 : 0);
  // landing shows only the dashed city outline; ward polygons switch on when
  // the first ward-level (choropleth) analysis lands
  const [base, setBase] = useState<BaseLayerState>({
    stops: true,
    metro: true,
    metroLines: true,
    wards: false,
    city: true,
  });
  const [resultLayers, setResultLayers] = useState<ResultLayer[]>([]);
  const [hoveredWard, setHoveredWard] = useState<string | null>(null);
  const [scenarioPoint, setScenarioPoint] = useState<[number, number] | null>(null);
  const [scenarioSourceId, setScenarioSourceId] = useState<string | null>(null);
  const [sweep, setSweep] = useState(0);

  const stops = useStopsData();
  const wards = useWards();
  const metroLines = useMetroLines();
  const cityBoundary = useCityBoundary();
  const mapRef = useRef<MapRef>(null);
  const conductor = useMapConductor(mapRef);
  const layerSeq = useRef(0);

  // real stop geometry for the map; `t` staggers the landing twinkle-in
  const stopsGeoJSON = useMemo(() => {
    const fc = stops.full
      ? ({
          type: "FeatureCollection",
          features: stops.points.map((p, i) => ({
            type: "Feature" as const,
            properties: {
              mode: "bus",
              name: stops.names?.[i] ?? undefined,
              // routes serving this stop (Observed) — zoom-out declutter key
              w: stops.weights?.[i] ?? 0,
              t: Math.random() * 0.8,
              evidence: "Observed",
            },
            geometry: { type: "Point" as const, coordinates: p },
          })),
        } as GeoJSON.FeatureCollection)
      : busStopsSampleGeoJSON();
    if (!stops.full)
      for (const f of fc.features)
        (f.properties as Record<string, unknown>).t = Math.random() * 0.8;
    return fc;
  }, [stops]);

  /**
   * The clustered PHYSICAL-STOP tier — one point per stop location, shown
   * while zoomed out. Two poles either side of a road are one dot here and
   * two dots in `stopsGeoJSON` once the user zooms past MapView's expand
   * threshold, so the map never implies there are 2.6x more stops than there
   * physically are, and never hides a real pole from someone inspecting a
   * specific junction.
   *
   * `m` (poles merged) and evidence "Estimated" ride along on each feature so
   * the attribute inspector can state what was merged and on what basis —
   * the clustering is a judgement, and the popover has to say so.
   *
   * Null when the crosswalk hasn't been built: the map then shows the flat
   * boarding list at every zoom rather than inventing cluster membership.
   */
  const physicalStopsGeoJSON = useMemo(() => {
    const tiers = stops.tiers;
    if (!stops.full || !tiers) return null;

    // a cluster's label is its first boarding point's name — the fixture
    // deliberately doesn't ship a second copy of the names array
    const label: (string | undefined)[] = [];
    tiers.c.forEach((ci, i) => {
      if (label[ci] === undefined) label[ci] = stops.names?.[i];
    });

    return {
      type: "FeatureCollection",
      features: tiers.physical.points.map((p, i) => ({
        type: "Feature" as const,
        properties: {
          mode: "bus",
          name: label[i] ?? undefined,
          w: tiers.physical.w[i] ?? 0,
          m: tiers.physical.m[i] ?? 1,
          t: Math.random() * 0.8,
          evidence: tiers.physical.evidence,
          method: `${tiers.method} @ ${tiers.threshold_m} m (${tiers.crs})`,
        },
        geometry: { type: "Point" as const, coordinates: p },
      })),
    } as GeoJSON.FeatureCollection;
  }, [stops]);

  const metroGeoJSON = useMemo(() => metroStopsGeoJSON(), []);

  // landing star chart: single 1.5 s staggered reveal, then done — no loop
  useEffect(() => {
    if (reduced || phase !== "landing" || twinkleProgress >= 1) return;
    const ctrl = animate(0, 1, {
      duration: 1.5,
      ease: "easeOut",
      onUpdate: (v) => setTwinkleProgress(v),
    });
    return () => ctrl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, phase]);

  // choreographed map-layer arrival: add hidden → fly → fade up (§6b beats 3–4)
  const onMapLayer = useCallback(
    (result: Extract<PropusResult, { kind: "map_layer" }>, intent: QueryIntent) => {
      const id = `q${++layerSeq.current}`;
      if (intent === "scenario") setScenarioSourceId(`res-${id}`);
      // ward-level analysis arrived — switch the ward boundaries on (§ the
      // landing shows only the dashed city outline until then)
      if (result.layer === "choropleth") setBase((b) => (b.wards ? b : { ...b, wards: true }));
      setResultLayers((ls) => [
        ...ls.filter((l) => !(intent === "scenario" && l.label.startsWith("Scenario"))),
        { id, label: result.label ?? result.layer, result, visible: true, opacity: 0 },
      ]);
      const settle = result.camera ? conductor.conduct(result.camera) : Promise.resolve();
      void settle.then(() => {
        if (conductor.reduced) {
          setResultLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: 1 } : l)));
          return;
        }
        animate(0, 1, {
          duration: motionTokens.dur.slow,
          ease: "easeOut",
          onUpdate: (v) =>
            setResultLayers((ls) => ls.map((l) => (l.id === id ? { ...l, opacity: v } : l))),
        });
      });
    },
    [conductor]
  );

  // A new query should read as a clean answer, not a palimpsest of every map
  // layer asked for so far — so the previous turn's result layer(s) turn off
  // the instant a new query starts (before its own layer arrives and fades
  // in). "Off", not deleted: still listed and re-checkable in the Layer
  // Manager, same as the chat pane keeps every past turn's result cards via
  // ArchivedTurn. A scenario slider commit (onScenarioCommit) never calls
  // this — it mutates the existing scenario layer in place, so it's
  // unaffected.
  const onQueryStart = useCallback(() => {
    setResultLayers((ls) => (ls.some((l) => l.visible) ? ls.map((l) => ({ ...l, visible: false })) : ls));
  }, []);

  const runner = useQueryRunner({ stops, wards, scenarioPoint, onMapLayer, onQueryStart });

  // U4 survey sweep (§6c.3): while the instrument computes, the queried extent
  // pulses ONCE — 0→1→0 over one pass, never a loop. Reduced motion: skipped.
  const running = runner.state.status === "running";
  useEffect(() => {
    if (!running || reduced || phase === "landing") return;
    const ctrl = animate(0, 1, {
      duration: motionTokens.dur.slow * 2,
      ease: "easeInOut",
      onUpdate: (v) => setSweep(Math.sin(v * Math.PI)),
      onComplete: () => setSweep(0),
    });
    return () => {
      ctrl.stop();
      setSweep(0);
    };
  }, [running, reduced, phase]);

  // MapLibre sizes its canvas from the DOM at mount/resize time; it doesn't
  // watch its container, so any layout change that resizes the map's flex
  // pane (landing→app, or the chat pane hiding/showing) needs an explicit
  // `resize()` call. Polling for ~600ms covers the CSS transition, not just
  // the instant the class flips.
  const resizeMapSoon = useCallback(() => {
    const t0 = performance.now();
    const tick = () => {
      mapRef.current?.getMap().resize();
      if (performance.now() - t0 < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  const submit = useCallback(
    (q: string) => {
      if (phase === "landing") {
        setPhase("app");
        // let the map settle into its new 62% pane before the flight
        resizeMapSoon();
      }
      void runner.run(q);
    },
    [phase, runner, resizeMapSoon]
  );

  const toggleChat = useCallback(() => {
    setChatVisible((v) => !v);
    resizeMapSoon();
  }, [resizeMapSoon]);

  // scenario: pick mode while a scenario query awaits its candidate point
  const pickMode =
    runner.state.intent === "scenario" &&
    scenarioPoint === null &&
    runner.state.status !== "idle";

  const onPickPoint = useCallback(
    (p: [number, number]) => {
      setScenarioPoint(p);
      void runner.run("If a metro station is added here, what falls within 800m?");
    },
    [runner]
  );

  const onScenarioCommit = useCallback(
    (radiusM: number) => {
      if (!scenarioPoint || !scenarioSourceId) return;
      const id = scenarioSourceId.replace(/^res-/, "");
      setResultLayers((ls) =>
        ls.map((l) =>
          l.id === id
            ? {
                ...l,
                label: `Scenario — ${Math.round(radiusM)} m around candidate`,
                result: {
                  ...l.result,
                  geojson: {
                    type: "FeatureCollection",
                    features: [
                      circlePolygon(scenarioPoint, radiusM),
                      {
                        type: "Feature",
                        properties: { name: "Candidate station", candidate: true },
                        geometry: { type: "Point", coordinates: scenarioPoint },
                      },
                    ],
                  },
                },
              }
            : l
        )
      );
    },
    [scenarioPoint, scenarioSourceId]
  );

  const landing = phase === "landing";

  return (
    <LayoutGroup>
      {warmup.visible && (
        <StartupScreen
          status={warmup.status}
          elapsedMs={warmup.elapsedMs}
          leaving={warmup.leaving}
          onSkip={warmup.dismiss}
        />
      )}

      <div className="h-screen flex flex-col overflow-hidden">
        {!landing && <TopBar mode={runner.state.mode} />}

        <div className="relative flex-1 flex min-h-0">
          {!landing && (
            <ChatPaneToggle
              visible={chatVisible}
              onToggle={toggleChat}
              widthPct={chatPaneWidthPct}
              onResize={setChatPaneWidthPct}
            />
          )}
          {!landing && chatVisible && (
            <ChatPane
              state={runner.state}
              onSubmit={submit}
              onRetry={runner.retry}
              onStop={runner.stop}
              onHoverWard={setHoveredWard}
              scenarioPoint={scenarioPoint}
              scenarioSourceId={scenarioSourceId}
              stops={stops}
              mapRef={mapRef}
              onScenarioCommit={onScenarioCommit}
              widthPct={chatPaneWidthPct}
            />
          )}

          {/* the shared map — mounts once, never remounts (zero-cut) */}
          <div className={landing ? "absolute inset-0" : "relative flex-1"}>
            <MapView
              ref={mapRef}
              layers={resultLayers}
              base={base}
              stopsGeoJSON={stopsGeoJSON}
              physicalStopsGeoJSON={physicalStopsGeoJSON}
              metroGeoJSON={metroGeoJSON}
              metroLinesGeoJSON={metroLines}
              wardsGeoJSON={wards}
              cityGeoJSON={cityBoundary}
              stopsAreSample={!stops.full}
              hoveredWard={hoveredWard}
              onHoverWard={setHoveredWard}
              onPickPoint={onPickPoint}
              pickMode={pickMode}
              interactive={!landing}
              twinkleProgress={twinkleProgress}
              sweep={sweep}
            />
            {!landing && (
              <LayerManager
                base={base}
                onBaseChange={setBase}
                layers={resultLayers}
                onLayersChange={setResultLayers}
                wardsLoaded={!!wards}
                metroLinesLoaded={!!metroLines}
              />
            )}
            {!landing && pickMode && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 rounded-md border border-borderStrong bg-vellum/95 px-3 py-1.5 text-xs text-ink shadow">
                Click the map to place the candidate station
              </div>
            )}
          </div>

          {/* ---- landing overlay: The Observatory (§6d) ---- */}
          {landing && (
            <div className="absolute inset-0 flex flex-col pointer-events-none isolate">
              <motion.nav
                layoutId="propus-nav"
                transition={reduced ? { duration: 0 } : motionTokens.spring}
                className="relative z-[1] flex items-center justify-between px-6 py-4 pointer-events-auto"
              >
                {/* `ink` (theme-aware) not `celestial` (near-black in both
                    themes) — the latter vanished on the dark-mode hero scrim */}
                <motion.span layoutId="propus-wordmark" className="font-serif text-xl text-ink">
                  Propus AI
                </motion.span>
                <div className="flex items-center gap-3">
                  <ThemeToggle className="text-inkMuted hover:text-ink" />
                  <a
                    href="/kit"
                    className="font-mono text-xs text-inkMuted hover:text-ink"
                  >
                    /kit
                  </a>
                </div>
              </motion.nav>

              {/* readability scrim over the muted hero map — vellum token, not a new color.
                  Px-based stops (not %) so the fixed ~576px text column is always fully
                  covered regardless of viewport, then fades to reveal the star-chart on the
                  right. Fixes U1 (WCAG AA on hero text).
                  NB: hero text/nav/footer carry `relative z-[1]` so they always paint
                  ABOVE this absolute scrim. Without it, static-flow text paints under a
                  positioned sibling — and Framer's y-spring transform temporarily lifted
                  the text into the positioned layer, so it looked dark for ~2s and then
                  dropped behind the scrim (faint) the moment the spring settled. */}
              <div
                aria-hidden
                className="absolute inset-y-0 left-0 w-full"
                style={{
                  // ~95% opaque vellum across the full text column (x≤~600px) — AA even
                  // over the densest stop clusters — then fades to reveal the star-chart.
                  background: `linear-gradient(to right, ${palette.vellum}f2 0px, ${palette.vellum}f2 620px, ${palette.vellum}00 1000px)`,
                }}
              />
              <div role="main" className="relative z-[1] flex-1 flex items-center px-6">
                <div className="max-w-xl pointer-events-auto">
                  <motion.h1
                    initial={reduced ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...motionTokens.spring, delay: reduced ? 0 : 0.2 }}
                    className="font-serif text-5xl md:text-6xl text-ink leading-[1.05] text-balance"
                  >
                    Ask the city a&nbsp;question.
                  </motion.h1>
                  <motion.p
                    initial={reduced ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...motionTokens.spring, delay: reduced ? 0 : 0.35 }}
                    className="mt-3 text-inkMuted text-base md:text-lg text-pretty"
                  >
                    Ask about Delhi&apos;s buses and metro in plain English. See which
                    neighbourhoods are poorly served, who lives far from a stop, and which stops
                    sit on the hottest ground. Every number shows where it came from.
                  </motion.p>
                  <motion.div
                    initial={reduced ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...motionTokens.spring, delay: reduced ? 0 : 0.5 }}
                    className="mt-6"
                  >
                    <QueryInput onSubmit={submit} ghost autoFocus />
                    <p className="mt-3 text-sm text-inkMuted">Not sure what to ask? Try one:</p>
                    <ul className="mt-1">
                      {landingExamples().map((q) => (
                        <li key={q}>
                          <button
                            type="button"
                            onClick={() => submit(q)}
                            className="flex min-h-[36px] items-center gap-2 rounded-sm px-2 text-left text-sm text-celestialMuted hover:bg-vellumShade hover:text-celestial"
                          >
                            <span className="font-mono text-primary" aria-hidden>
                              ▸
                            </span>
                            {q}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <HelpDialog
                      label="New here? How to read the results"
                      className="-ml-2 mt-1 text-celestialMuted hover:text-celestial"
                    />
                  </motion.div>
                  <motion.div
                    initial={reduced ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: motionTokens.dur.slow, delay: reduced ? 0 : 0.9 }}
                    className="mt-10"
                  >
                    <ProofStrip />
                  </motion.div>
                </div>
              </div>

              {/* No footer credit here: it duplicated the map's own attribution
                  control. Sources now live only in that control (collapsed to
                  the `i`, opens on hover) — including the ward credit, which
                  moved there with it. */}
            </div>
          )}
        </div>
      </div>
    </LayoutGroup>
  );
}

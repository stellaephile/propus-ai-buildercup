"use client";

/**
 * Scenario slider (D5) — the lean-forward moment. The slider drives a
 * useMotionValue; the buffer geometry on the map and the "stops covered"
 * count subscribe to it directly (zero React re-renders while dragging).
 * The authoritative recount fires debounced on release. In demo mode the
 * recount is a real client-side computation over real stop coordinates;
 * population needs the backend and says so.
 */

import { animate, useMotionValue, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { GeoJSONSource } from "maplibre-gl";
import { circlePolygon, countWithin } from "@/lib/geo";
import { motionTokens } from "@/lib/tokens";
import type { StopsData } from "@/lib/data/useStopsData";
import { EvidenceTag } from "./EvidenceTag";

export function ScenarioPanel({
  point,
  stops,
  mapRef,
  sourceId,
  onCommit,
}: {
  point: [number, number] | null;
  stops: StopsData;
  mapRef: React.RefObject<MapRef>;
  /** map source id whose polygon we mutate directly while dragging */
  sourceId: string;
  onCommit: (radiusM: number) => void;
}) {
  const reduced = useReducedMotion();
  const radius = useMotionValue(800);
  const [display, setDisplay] = useState(800);
  const [count, setCount] = useState<number | null>(
    point ? countWithin(stops.points, point, 800) : null
  );
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // subscribe the map geometry to the motion value — no React re-render
  useEffect(() => {
    if (!point) return;
    const unsub = radius.on("change", (r) => {
      const map = mapRef.current?.getMap();
      const src = map?.getSource(sourceId) as GeoJSONSource | undefined;
      if (src) {
        src.setData({
          type: "FeatureCollection",
          features: [
            circlePolygon(point, r),
            {
              type: "Feature",
              properties: { name: "Candidate station", candidate: true },
              geometry: { type: "Point", coordinates: point },
            },
          ],
        });
      }
      setDisplay(Math.round(r));
    });
    return unsub;
  }, [point, radius, mapRef, sourceId]);

  const commit = useCallback(
    (r: number) => {
      if (!point) return;
      setCount(countWithin(stops.points, point, r)); // real recompute (client-side demo)
      onCommit(r);
    },
    [point, stops, onCommit]
  );

  const onInput = (v: number) => {
    if (reduced) radius.jump(v);
    else radius.set(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => commit(radius.get()), 250);
  };

  useEffect(() => {
    // buffer bloom on placement (§6b): springSoft from 0 → 800
    if (!point) return;
    setCount(countWithin(stops.points, point, 800));
    if (reduced) {
      radius.jump(800);
      return;
    }
    radius.jump(80);
    const ctrl = animate(radius, 800, {
      type: "spring",
      stiffness: motionTokens.springSoft.stiffness,
      damping: motionTokens.springSoft.damping,
    });
    return () => ctrl.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point?.[0], point?.[1]]);

  if (!point) {
    return (
      <div className="rounded-lg border border-border bg-sheet px-4 py-3 text-sm text-inkMuted">
        Click the map to drop a candidate metro station, then drag the radius.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-sheet px-4 py-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-ink font-medium">Scenario — candidate station</span>
        <span className="font-mono text-xs text-inkMuted tabular-nums">
          {point[1].toFixed(5)}°N {point[0].toFixed(5)}°E
        </span>
      </div>
      <label className="mt-3 block text-xs text-inkMuted" htmlFor="scenario-radius">
        Walk radius — <span className="font-mono tabular-nums text-ink">{display} m</span>
      </label>
      <input
        id="scenario-radius"
        type="range"
        min={300}
        max={1500}
        step={10}
        defaultValue={800}
        onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))}
        className="mt-1 w-full accent-current text-primary"
      />
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-mono text-3xl tabular-nums text-ink">{count ?? "—"}</span>
        <span className="text-xs text-inkMuted">
          bus stops within reach <EvidenceTag evidence="Calculated" />
          {!stops.full && " · sample — run npm run fixtures"}
        </span>
      </div>
      <p className="mt-1.5 text-xs text-inkFaint">
        Residents within reach requires WorldPop zonal stats on the backend — shown as “—”
        rather than guessed.
      </p>
    </div>
  );
}

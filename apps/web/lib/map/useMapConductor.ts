"use client";

/**
 * The conductor (§6b): Framer owns the DOM, the map owns itself. This hook
 * bridges the two timelines — fire a camera flight, resolve on `moveend`,
 * then let the caller gate the layer fade. Reduced-motion users skip the
 * flight (`jumpTo`) and layers appear at full opacity instantly.
 */

import { useCallback, useRef } from "react";
import { useReducedMotion } from "framer-motion";
import type { MapRef } from "react-map-gl/maplibre";
import type { CameraSpec } from "@propus/contract";
import { flyToMs } from "../tokens";

export function useMapConductor(mapRef: React.RefObject<MapRef>) {
  const reduced = useReducedMotion();
  const flightSeq = useRef(0);

  /** Fly (or jump) to camera; resolves when the map settles. */
  const conduct = useCallback(
    (camera: CameraSpec): Promise<void> => {
      const map = mapRef.current?.getMap();
      if (!map) return Promise.resolve();
      const seq = ++flightSeq.current;
      // A `bounds` extent frames the answer precisely; center/zoom is the fallback.
      // Clamp padding so it never exceeds the pane (a narrow map would otherwise
      // be forced to zoom out absurdly to satisfy the padding).
      const cv = map.getCanvas();
      const pad = Math.max(16, Math.min(64, Math.floor(Math.min(cv.clientWidth, cv.clientHeight) / 6)));
      const target = camera.bounds
        ? map.cameraForBounds(
            [
              [camera.bounds[0], camera.bounds[1]],
              [camera.bounds[2], camera.bounds[3]],
            ],
            { padding: pad, maxZoom: 14 }
          ) ?? { center: camera.center, zoom: camera.zoom }
        : { center: camera.center, zoom: camera.zoom };
      const full = {
        center: target.center,
        zoom: target.zoom,
        pitch: camera.pitch ?? 0,
        bearing: camera.bearing ?? 0,
      };
      if (reduced) {
        map.jumpTo(full);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const onEnd = () => {
          map.off("moveend", onEnd);
          resolve();
        };
        map.on("moveend", onEnd);
        map.flyTo({ ...full, duration: flyToMs, essential: false });
        // safety: if a newer flight preempts this one, resolve anyway
        setTimeout(() => {
          if (flightSeq.current !== seq) {
            map.off("moveend", onEnd);
            resolve();
          }
        }, flyToMs + 400);
      });
    },
    [mapRef, reduced]
  );

  /** rAF opacity ramp on a paint property, gated after `conduct`. */
  const fadeLayer = useCallback(
    (layerId: string, prop: string, to: number, ms = 400) => {
      const map = mapRef.current?.getMap();
      if (!map || !map.getLayer(layerId)) return;
      if (reduced) {
        map.setPaintProperty(layerId, prop, to);
        return;
      }
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        const eased = 1 - (1 - k) * (1 - k); // ease-out
        if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, to * eased);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [mapRef, reduced]
  );

  /** Single survey sweep (§6c.3): pulse an extent's opacity ONCE, never loop. */
  const surveySweep = useCallback(
    (layerId: string, prop: string, base: number) => {
      const map = mapRef.current?.getMap();
      if (!map || !map.getLayer(layerId) || reduced) return;
      const t0 = performance.now();
      const ms = 900;
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / ms);
        const pulse = base + 0.25 * Math.sin(Math.PI * k);
        if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, pulse);
        if (k < 1) requestAnimationFrame(tick);
        else if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, base);
      };
      requestAnimationFrame(tick);
    },
    [mapRef, reduced]
  );

  return { conduct, fadeLayer, surveySweep, reduced: !!reduced };
}

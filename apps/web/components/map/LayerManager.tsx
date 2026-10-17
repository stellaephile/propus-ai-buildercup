"use client";

/**
 * Layer manager (§9): toggle + opacity + reorder for every data layer.
 * Fully keyboard-operable; sliders and checkboxes are native inputs.
 */

import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { motionTokens } from "@/lib/tokens";
import type { BaseLayerState, ResultLayer } from "./MapView";

export function LayerManager({
  base,
  onBaseChange,
  layers,
  onLayersChange,
  wardsLoaded,
  metroLinesLoaded,
}: {
  base: BaseLayerState;
  onBaseChange: (b: BaseLayerState) => void;
  layers: ResultLayer[];
  onLayersChange: (l: ResultLayer[]) => void;
  wardsLoaded: boolean;
  metroLinesLoaded: boolean;
}) {
  const [open, setOpen] = useState(true);
  const reduced = useReducedMotion();

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    const next = layers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onLayersChange(next);
  };

  const baseRows: { key: keyof BaseLayerState; label: string; disabled?: boolean }[] = [
    { key: "stops", label: "Bus stops (OTD Delhi)" },
    { key: "metro", label: "Metro stations (DMRC)" },
    { key: "metroLines", label: metroLinesLoaded ? "Metro lines (OSM)" : "Metro lines — not loaded", disabled: !metroLinesLoaded },
    { key: "wards", label: wardsLoaded ? "Ward boundaries (OpenCity/DataMeet)" : "Ward boundaries — not loaded", disabled: !wardsLoaded },
    { key: "city", label: "City boundary (dissolved wards)" },
  ];

  return (
    <motion.div
      layout={reduced ? false : true}
      transition={motionTokens.spring}
      className="absolute left-2 bottom-10 z-10 w-64 rounded-lg border border-border bg-vellum/95 shadow-ambient"
    >
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-ink"
      >
        Layers
        <span className="font-mono text-inkFaint" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2 space-y-2 max-h-64 overflow-auto">
          {layers.map((l, i) => (
            <div key={l.id} className="text-xs">
              <div className="flex items-center gap-2">
                <input
                  id={`lyr-${l.id}`}
                  type="checkbox"
                  checked={l.visible}
                  onChange={() =>
                    onLayersChange(
                      layers.map((x) => (x.id === l.id ? { ...x, visible: !x.visible } : x))
                    )
                  }
                  className="accent-current text-primary"
                />
                <label htmlFor={`lyr-${l.id}`} className="flex-1 truncate text-ink" title={l.label}>
                  {l.label}
                </label>
                <button onClick={() => move(i, -1)} aria-label={`Move ${l.label} up`} className="text-inkFaint hover:text-ink px-0.5">↑</button>
                <button onClick={() => move(i, 1)} aria-label={`Move ${l.label} down`} className="text-inkFaint hover:text-ink px-0.5">↓</button>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(l.opacity * 100)}
                onChange={(e) =>
                  onLayersChange(
                    layers.map((x) =>
                      x.id === l.id ? { ...x, opacity: Number(e.target.value) / 100 } : x
                    )
                  )
                }
                aria-label={`${l.label} opacity`}
                className="mt-1 w-full h-1 accent-current text-primary"
              />
            </div>
          ))}
          {layers.length > 0 && <hr className="border-border" />}
          {baseRows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-xs">
              <input
                id={`base-${r.key}`}
                type="checkbox"
                checked={base[r.key]}
                disabled={r.disabled}
                onChange={() => onBaseChange({ ...base, [r.key]: !base[r.key] })}
                className="accent-current text-primary"
              />
              <label
                htmlFor={`base-${r.key}`}
                className={r.disabled ? "text-inkFaint" : "text-inkMuted"}
              >
                {r.label}
              </label>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

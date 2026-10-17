"use client";

/**
 * map_layer chat-pane card — the layer itself renders on the map (via the
 * conductor); this card is its handle in the conversation: label, legend
 * swatches, feature count, and export actions (GeoJSON per §9).
 */

import type { Methodology, PropusResult } from "@propus/contract";
import { type ColorToken } from "@/lib/tokens";
import { useThemePalette } from "@/lib/theme";
import { ResultCard } from "./ResultCard";

type Props = Extract<PropusResult, { kind: "map_layer" }> & { methodology?: Methodology };

export function MapLayerCard({ layer, geojson, label, legend, methodology }: Props) {
  const { palette } = useThemePalette();
  const exportGeoJSON = () => {
    const blob = new Blob([JSON.stringify(geojson)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(label ?? layer).replace(/\W+/g, "-").toLowerCase()}.geojson`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <ResultCard
      title={label ?? `Map layer — ${layer}`}
      methodology={methodology}
      actions={
        <button
          onClick={exportGeoJSON}
          className="font-mono text-xs text-inkMuted hover:text-ink hover:bg-vellumShade border border-border rounded-sm px-1.5 py-0.5 transition-colors"
        >
          GeoJSON ↓
        </button>
      }
    >
      <div className="px-4 py-2.5 flex items-center justify-between text-xs text-inkMuted">
        <div className="flex items-center gap-3">
          {(legend ?? []).map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5">
              <span
                className="w-3 h-3 rounded-sm border border-borderStrong"
                style={{ background: palette[l.token as ColorToken] ?? palette.primary }}
                aria-hidden
              />
              {l.label}
            </span>
          ))}
        </div>
        <span className="font-mono tabular-nums">
          {geojson.features.length} feature{geojson.features.length === 1 ? "" : "s"} · shown on map
        </span>
      </div>
    </ResultCard>
  );
}

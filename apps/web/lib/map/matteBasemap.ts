/**
 * Matte basemap (TASKS.md M3). After a style loads, desaturate the BASEMAP's
 * own layer paints in place so the tiles read as matte print — while every
 * data layer (choropleth ramp, metro line identities, the amber scalpel)
 * keeps its exact token hex. This is why it's per-layer paint surgery and not
 * a CSS filter on the canvas: a canvas filter would mute the data ink too.
 *
 * Lightness is deliberately untouched, so map-label contrast is preserved
 * (§3.7) and the map-to-PNG export remains publication-consistent with what
 * is on screen (the desaturation IS the cartography, not screen dressing).
 */
import type { Map as MaplibreMap } from "maplibre-gl";
import { matteTokens } from "@/lib/tokens";

// One entry per maplibre Style INSTANCE — a fresh instance is created by every
// setStyle (theme flip), so the transform runs exactly once per loaded style
// and can never compound across styledata refires or React effect re-runs.
const applied = new WeakSet<object>();

/** Parse #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba(), hsl()/hsla() → [r,g,b,a]. */
function parseColor(str: string): [number, number, number, number] | null {
  const s = str.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (![3, 4, 6, 8].includes(h.length) || /[^0-9a-fA-F]/.test(h)) return null;
    const exp =
      h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
    const r = parseInt(exp.slice(0, 2), 16);
    const g = parseInt(exp.slice(2, 4), 16);
    const b = parseInt(exp.slice(4, 6), 16);
    const a = exp.length === 8 ? parseInt(exp.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  const hsl = s.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (hsl) {
    const [r, g, b] = hslToRgb(Number(hsl[1]) / 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100);
    return [r, g, b, hsl[4] === undefined ? 1 : Number(hsl[4])];
  }
  return null;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(f(h + 1 / 3) * 255),
    Math.round(f(h) * 255),
    Math.round(f(h - 1 / 3) * 255),
  ];
}

/** Desaturate one CSS color string; null when the string isn't a color. */
function desaturate(color: string): string | null {
  const rgba = parseColor(color);
  if (!rgba) return null;
  const [r0, g0, b0, a] = rgba;
  const [h, s, l] = rgbToHsl(r0, g0, b0);
  const [r, g, b] = hslToRgb(h, s * matteTokens.basemapSaturation, l);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

/**
 * Walk a paint value — plain color string or a nested expression array (match,
 * interpolate, …) — desaturating every string that parses as a color. Enum
 * strings ("round", property names) don't parse and pass through untouched.
 */
function transformValue(value: unknown): { changed: boolean; value: unknown } {
  if (typeof value === "string") {
    const out = desaturate(value);
    return out !== null && out !== value ? { changed: true, value: out } : { changed: false, value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = transformValue(v);
      changed = changed || r.changed;
      return r.value;
    });
    return { changed, value: changed ? out : value };
  }
  return { changed: false, value };
}

export function applyMatteBasemap(map: MaplibreMap): void {
  if (!map.isStyleLoaded()) return;
  // `style` is maplibre-internal, but it is the only per-setStyle identity
  // handle: getStyle() serializes a fresh object on every call.
  const styleInstance = (map as unknown as { style?: object }).style;
  if (!styleInstance || applied.has(styleInstance)) return;
  const style = map.getStyle();
  if (!style?.layers) return;
  applied.add(styleInstance);
  for (const layer of style.layers) {
    // never touch our own data layers (added as base-*/res-* by MapView)
    if (layer.id.startsWith("base-") || layer.id.startsWith("res-")) continue;
    const paint = (layer as { paint?: Record<string, unknown> }).paint;
    if (!paint) continue;
    for (const key of Object.keys(paint)) {
      if (!key.endsWith("-color")) continue;
      const { changed, value } = transformValue(paint[key]);
      if (changed) map.setPaintProperty(layer.id, key, value);
    }
  }
}

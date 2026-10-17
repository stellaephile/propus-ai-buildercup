/**
 * MatteGrain (TASKS.md M2) — the app-wide matte paper tooth. One fixed,
 * pointer-transparent overlay carrying a STATIC feTurbulence noise tile built
 * from matteTokens. Blend mode, opacity var, and the prefers-contrast/print
 * kill-switches live in globals.css (`.matte-grain`); the SVG params live here
 * so they stay token-driven rather than hardcoded in CSS.
 *
 * Being a DOM overlay, it is invisible to every export path — map-to-PNG reads
 * the WebGL canvas, CSV/GeoJSON are data — so exported output stays
 * publication-clean by construction.
 */
import { matteTokens } from "@/lib/tokens";

const { tilePx, baseFrequency, octaves } = matteTokens.grain;

const GRAIN_URI = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${tilePx}" height="${tilePx}"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="${baseFrequency}" numOctaves="${octaves}" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>`
)}`;

export function MatteGrain() {
  return (
    <div
      aria-hidden
      className="matte-grain"
      style={{ backgroundImage: `url("${GRAIN_URI}")` }}
    />
  );
}

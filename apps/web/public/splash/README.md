# Startup backdrop

`loading_screen.mp4` — 1280×720, 6.0s, H.264, 2.1 MB. Plays full-bleed behind
the startup card while the Render API wakes. Wired via `NEXT_PUBLIC_SPLASH_BG`;
unset that and the procedural field in `components/startup/SplashBackdrop.tsx`
renders instead, so the app has no hard dependency on this file.

`.gitignore` has a global `*.mp4`, with a negation for this directory — without
it the video never reaches Vercel and production silently falls back to the
procedural field. Keep the negation if you rename anything here.

## Treatment

Measured over four frames of this asset:

| reading | value | consequence |
|---|---|---|
| mean luma | 0.069 | dark enough that the numeral reads without a heavy scrim |
| median luma | 0.059 | — |
| pixels above 0.6 luma | 0.17% | no blown highlights to fight |
| saturated pixels | 0.93% | the coloured nodes are sparse glints, not a wash |

Hue spread of those saturated pixels: azure 20%, green 15%, blue 14%,
magenta 14%, violet 13%, orange 8%, cyan 6%, red 5%, yellow 3%.

That spread is close to the DMRC line palette, where colour is a **data
attribute**, not decoration (§1.3) — and ~11% falls in the amber band, which is
the underserved-data scalpel (§3.4). So the video is desaturated on the way in.
`splashTokens.backdropSaturation` is the single knob: 1 shows the asset
untouched, lower pulls the glints toward instrument-neutral.

The scrim is a vignette only (`scrimCenter` / `scrimEdge`) — the centre is left
clear because the measurements say it doesn't need covering.

## The one rule

Whatever plays here appears on the title card only. It never shares a frame with
the map, and it must not read as cartography: no coastlines, no road or rail
networks, no ward-like polygons, no place labels. A GIS reviewer who mistakes
decorative geometry for our data is the worst outcome for this build
(CLAUDE.md §3.1, §12). The current asset is an abstract node field, which is
clear of that — it is a graph, not a place.

## Replacing it

Budget: video ≤ 3 MB, ≤ 6s, seamless loop, `.webm` (VP9) preferred with an
`.mp4` fallback; ship a `.jpg` poster as `NEXT_PUBLIC_SPLASH_BG_POSTER` — it is
what `prefers-reduced-motion` viewers see, since the loop is never fetched for
them. Stills: ≤ 400 KB.

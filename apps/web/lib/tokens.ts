/**
 * lib/tokens.ts — THE single source of truth for design + motion tokens.
 * Mirrors DESIGN.md v2 (The Cartographic Intelligence Framework). If this file
 * and DESIGN.md disagree, DESIGN.md wins — fix this file.
 *
 * Two color families: Terrestrial (warm Vellum substrate) and Celestial (deep
 * navies/blues of the data layer). Amber is neither — it is a scalpel (§1.2):
 * underserved/alert DATA points only, never a panel, sidebar, glow, or ramp.
 * Numbers use the mono scale (Martian Mono); headlines serif (Libre Caslon);
 * prose sans (Atkinson Hyperlegible). No component hardcodes a hex — import here.
 */

/**
 * Light mode — the chart on the archivist's desk. This is the default outlet
 * consumed by Tailwind (via tailwind.config.ts) and by anything that can't read
 * CSS variables (MapLibre paint, deck.gl, Recharts). §1.1 + §1.3.
 */
export const colors = {
  /** vellum L0 — main canvas, the paper (§1.1) */
  vellum: "#fcf9f3",
  /** vellumShade L1 — chat sidebar, zebra rows */
  vellumShade: "#f6f3ed",
  /** vellumDeep — input field fills, pressed states */
  vellumDeep: "#efeadf",
  /** sheet L2 — active/raised cards, agent bubbles */
  sheet: "#ffffff",

  /** celestial — top bar, wordmark, heaviest ink (§1.1) */
  celestial: "#0D1C2E",
  /** muted celestial — secondary UI ink / chart series / Calculated stamp */
  celestialMuted: "#41597a",

  /** primary — Prussian blue: actions, links, buffers (the survey pigment) */
  primary: "#17527B",
  /** primaryInk — hover/active on primary */
  primaryInk: "#0F3A59",

  /** madder — selection ink: hovered/selected routes & rows. Never an alarm. */
  madder: "#9C4036",

  /** ink — text. Never #000000. (§1.1) */
  ink: "#1c1c18",
  inkMuted: "#5f5c52",
  /** faintest legible ink — must stay ≥4.5:1 on vellum/sheet (WCAG AA, §3.7);
   *  #8a8676 failed at 3.5:1 and was darkened */
  inkFaint: "#6f6b5e",

  /** slate — user chat bubbles ("inputs into the system") (§4) */
  slate: "#E8EDF4",

  /** THE amber scalpel — underserved/alert data FILLS only (§1.2) */
  alert: "#d4853a",
  /** amber TEXT/numerals — AA on vellum; alert (#d4853a) fails as text (§1.1) */
  alertInk: "#8a4d13",

  /** lamplight — Thinking Light only (§6). Desaturated warm, hue-distant from alert. */
  lamplight: "#f3e4c8",

  /** text on celestial navy */
  onCelestial: "#f3efe6",
  onCelestialMuted: "#9fb0c9",

  /** choropleth ramp (Celestial), sequential vellum → celestial (§1.3).
   *  Amber stays OUT of the ramp so it reads as a discrete alarm. */
  ramp0: "#efe9dc",
  ramp1: "#cdd5dc",
  ramp2: "#93a9bd",
  ramp3: "#51749a",
  ramp4: "#1d4568",

  /** buffer / catchment stroke + fill — plum: blue is saturated by the metro
   *  line identities, so analysis overlays get their own non-metro hue */
  buffer: "#7D3C64",
  bufferFill: "#7D3C64",

  /** stop points on the muted hero map */
  stopPoint: "#e8b26a",

  /** cursor / placement marker ring — a bright cyan that reads on both
   *  basemaps and does NOT collide with the amber alert scalpel (§1.2).
   *  Brighter in dark mode (see colorsDark). Its centre dot uses `ink`
   *  (theme-aware) so it flips to stay legible against the ring. */
  cursor: "#0E8DA8",

  /** focus ring — 2px primary, AA in both modes (§1.4) */
  focusRing: "#17527B",

  /** retained surface-shift helpers used by legacy borders (D1 pass removes these) */
  border: "#e9e2d2",
  borderStrong: "#d4cab2",

  /** DMRC line identity colors — DATA colors, not UI palette. Keyed off the
   *  route_long_name prefix in the DMRC GTFS feed (RED_, PINK_, …); the only
   *  sanctioned greens/purples/pinks in the app, because here color IS the
   *  attribute (like amber for underserved). Never use these for UI chrome. */
  metroRed: "#EE2E24",
  metroYellow: "#FFCD00",
  metroBlue: "#2A6EBB",
  metroGreen: "#009E49",
  metroViolet: "#563E99",
  metroPink: "#E86EA4",
  metroMagenta: "#A3238E",
  metroGrey: "#6D6E71",
  metroOrange: "#F58220",
  metroAqua: "#00ADD0",
  metroRapid: "#78BE20",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * Night Chart — dark mode (§7). The star chart itself: paper and ink trade
 * places. Light is the default; dark is a deliberate, persisted instrument
 * setting, never OS-forced. This is the JS outlet for map/chart paints; the DOM
 * outlet is CSS custom properties on [data-theme="dark"]. One source, two
 * outlets (§7.2). Wired by the D5 Night-Chart pass; defined here now so the
 * palette lives in exactly one place.
 */
export const colorsDark: Record<ColorToken, string> = {
  vellum: "#0A1521",
  vellumShade: "#0D1C2E",
  vellumDeep: "#16283C",
  sheet: "#1B3048",
  celestial: "#060d15",
  celestialMuted: "#7d8a9c",
  primary: "#7EB5DE",
  primaryInk: "#A7CDEB",
  madder: "#D99087",
  ink: "#f3efe6",
  inkMuted: "#b8c0cd",
  inkFaint: "#7d8a9c",
  slate: "#243A52",
  alert: "#d4853a",
  alertInk: "#e8b26a",
  lamplight: "#f3e4c8",
  onCelestial: "#f3efe6",
  onCelestialMuted: "#9fb0c9",
  ramp0: "#132C44",
  ramp1: "#2C4A68",
  ramp2: "#587697",
  ramp3: "#93A9BD",
  ramp4: "#D9DFE2",
  buffer: "#C687A8",
  bufferFill: "#C687A8",
  stopPoint: "#e8b26a",
  // brighter cyan so the placement marker pops on the Night Chart basemap
  cursor: "#2DD4EE",
  focusRing: "#7EB5DE",
  border: "#1B3048",
  borderStrong: "#2C4A68",
  // metro identity colors keep their hue in the dark; the deep ones are
  // lightened just enough to read against the Night Chart navy
  metroRed: "#F0524A",
  metroYellow: "#FFCD00",
  metroBlue: "#5B94D6",
  metroGreen: "#00B558",
  metroViolet: "#8B79C6",
  metroPink: "#E86EA4",
  metroMagenta: "#C75AB5",
  metroGrey: "#9BA0A6",
  metroOrange: "#F58220",
  metroAqua: "#00ADD0",
  metroRapid: "#78BE20",
} as const;

/**
 * DMRC GTFS route_long_name prefix → line color token. Drives the data-driven
 * line paint in MapView when a map_layer style sets `colorProperty` (the
 * feature property holding one of these prefixes). Data decides the color;
 * components never hardcode a line hex.
 */
export const metroLineTokens = {
  AQUA: "metroAqua",
  BLUE: "metroBlue",
  GRAY: "metroGrey",
  GREEN: "metroGreen",
  MAGENTA: "metroMagenta",
  "ORANGE/AIRPORT": "metroOrange",
  PINK: "metroPink",
  RAPID: "metroRapid",
  RED: "metroRed",
  VIOLET: "metroViolet",
  YELLOW: "metroYellow",
} as const satisfies Record<string, ColorToken>;

/**
 * Smallest text sizes, px. 12 is the floor — 10px mono uppercase failed
 * legibility review (§3.7); DOM text uses the matching Tailwind `text-xs` step,
 * this is the JS outlet for Recharts/SVG which can't read utility classes.
 */
export const typeScale = {
  axis: 12,
} as const;

export const type = {
  serif: "var(--font-serif)", // Libre Caslon Text — headlines, wordmark, landing hero
  sans: "var(--font-sans)", // Atkinson Hyperlegible — UI, chat, prose (the a11y selling point)
  mono: "var(--font-mono)", // Martian Mono — every number, coords, evidence stamps, tickers
} as const;

export const spacing = {
  /** canonical layout: chat pane / map split (CLAUDE.md §8) — the default;
   * user-resizable within [chatPaneMinPct, chatPaneMaxPct], see
   * lib/useChatPaneWidth.ts. */
  chatPanePct: 38,
  mapPanePct: 62,
  chatPaneMinPct: 24,
  chatPaneMaxPct: 55,
  topBarH: 48,
} as const;

/**
 * Motion tokens (CLAUDE.md §6b) — exactly two springs and three durations.
 * Every animation in the app references these. Never inline configs.
 */
export const motionTokens = {
  spring: { type: "spring", stiffness: 300, damping: 30 }, // UI: cards, drawers, morphs
  springSoft: { type: "spring", stiffness: 120, damping: 20 }, // numbers, buffer bloom
  dur: { fast: 0.15, base: 0.3, slow: 0.5 }, // fades, ease-out
} as const;

/**
 * Matte finish (TASKS.md Phase M) — the app reads as a matte print, not a
 * glossy screen. One source of truth for every matte knob; the DOM outlet is
 * `--matte-grain-opacity` (lib/theme.tsx), the JS outlets are MatteGrain and
 * lib/map/matteBasemap.ts. The grain is STATIC — never animated (§6b).
 */
export const matteTokens = {
  /** paper-tooth grain overlay (M2). Opacities are capped so every AA text
   *  pair still passes underneath it: ≤5% multiply shifts a ground's relative
   *  luminance by under 2%, which cannot flip a 4.5:1 pair below threshold. */
  grain: {
    /** light mode — multiply on vellum */
    opacity: 0.035,
    /** dark mode — multiply on the Night Chart navy needs a touch more to read */
    opacityDark: 0.05,
    /** feTurbulence params for the noise tile */
    baseFrequency: 0.9,
    octaves: 2,
    /** tile size, px — large enough that the repeat is invisible */
    tilePx: 240,
  },
  /** matte basemap (M3): saturation multiplier applied to BASEMAP layer paints
   *  only — data layers keep their exact token hexes, and lightness is left
   *  untouched so map-label contrast is preserved (§3.7). */
  basemapSaturation: 0.78,
} as const;

/** stagger for result-card reveal (§6b beat 2) */
export const staggerChildren = 0.08;

/** conductor camera flight duration, ms (§6b beat 3) */
export const flyToMs = 1200;

export const evidenceTokens: Record<string, { label: string }> = {
  Observed: { label: "Observed" },
  Calculated: { label: "Calculated" },
  Estimated: { label: "Estimated" },
  Modelled: { label: "Modelled" },
};

/**
 * Startup screen — the title card shown while the Render free-tier API wakes
 * (CLAUDE.md §5 "keep-warm": cold start is the backend, not the frontend).
 *
 * Hard boundary (§3.1 / §12): the splash is a SEPARATE SHOT. Whatever art sits
 * behind the wordmark must never share a frame with the real map, and must
 * never read as cartography — no coastlines, no road networks, no ward-like
 * polygons, no place labels. It ends before any real geometry is on screen, so
 * nothing decorative can be mistaken for analysis output.
 */
export const splashTokens = {
  /** never flash: hold the card at least this long even if the API is warm */
  minMs: 1200,
  /** after this, stop waiting and enter degraded/demo mode with an honest note.
   *  Was 20000 — too short: Render's free tier commonly takes 30-50s+ to wake
   *  a sleeping instance, and this backend's boot is heavier than a bare
   *  FastAPI app (google-adk pulls sqlalchemy + litellm on top of psycopg2).
   *  A correctly-configured, genuinely-live backend was tripping "unreachable"
   *  simply because it hadn't finished booting yet. 45s covers a realistic
   *  cold start; the keep-warm ping (CLAUDE.md §5.5) is what actually keeps a
   *  user from ever sitting through this — this ceiling is the safety net for
   *  when that ping has lapsed, not the primary mitigation. */
  maxMs: 45000,
  /** gap between /health polls */
  pollMs: 1500,
  /** past this with no answer, the readout switches from "connecting" to "waking" */
  warmingAfterMs: 2500,
  /** reticle draw-on + wordmark rise, seconds */
  markDrawSec: 1.1,
  /** swipe-up reveal on exit — the card lifts off rather than dissolving.
   *  Easing matches the reference LoadingScreen component. */
  exitEase: "cubic-bezier(0.4, 0, 0.2, 1)",
  /** Backdrop video treatment. Measured on loading_screen.mp4: mean luma 0.069,
   *  only 0.17% of pixels above 0.6 — it is dark enough that the wordmark reads
   *  without a heavy scrim, so the scrim stays light and the art stays visible.
   *  Saturation is pulled back because the node glints span the full spectrum
   *  (azure/green/blue/magenta/violet/orange), which is the DMRC line palette —
   *  and line color is a DATA attribute in this app (§1.3), not decoration.
   *  Set to 1 to show the asset untouched. */
  backdropSaturation: 0.7,
  /** Scrim alpha at centre → edge, hex suffixes on `celestial`. Now that the
   *  card carries only a corner numeral, the centre is left clear and the
   *  scrim is just a vignette — it darkens the corners the reading sits in
   *  without veiling the art. */
  scrimCenter: "00",
  scrimEdge: "66",
} as const;

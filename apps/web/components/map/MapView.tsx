"use client";

/**
 * The map pane. Real basemap (OpenFreeMap Positron — real Delhi geography,
 * no API key), real GTFS points, real ward polygons when fetched. Includes
 * the GIS furniture the primary user expects (§9): scale bar, coordinate
 * readout, north indicator, legend, attribute inspection, PNG export.
 * The map is deliberately "dumb": it draws whatever the typed results give it.
 */

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import Map, {
  AttributionControl,
  Layer,
  NavigationControl,
  Popup,
  ScaleControl,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from "react-map-gl/maplibre";
import type { GeoJSONSource, Map as MaplibreMap } from "maplibre-gl";
import type { PropusResult } from "@propus/contract";
import { colors, metroLineTokens, type ColorToken } from "@/lib/tokens";
import { useThemePalette } from "@/lib/theme";
import { DELHI_BBOX } from "@/lib/geo";
import { applyMatteBasemap } from "@/lib/map/matteBasemap";
import { EvidenceTag } from "../EvidenceTag";
import type { Evidence } from "@propus/contract";

// Light = OpenFreeMap Positron; dark = CARTO Dark Matter (§7 Night Chart). Both
// are free, key-less, and real Delhi geography — a matched light/dark pair, so
// the token symbology reads on either substrate.
export const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
export const MAP_STYLE_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Overview-zoom "key stop" threshold: distinct routes serving the stop
 *  (fixture `w`, Observed). 20 ≈ the top decile of the 10.5k network. */
const KEY_STOP_MIN_ROUTES = 20;

/**
 * Below this zoom, 4,347 individual physical-stop dots (see STOP_EXPAND_ZOOM
 * below) blur into an undifferentiated scatter — there are too many to read
 * as places, and too close together to tell one from the next. A real
 * MapLibre `cluster: true` GeoJSON source aggregates them into count bubbles
 * instead, exactly the way a marker-cluster library would.
 *
 * This is a PURE display technique layered on top of the same Estimated
 * physical-location tier: a bubble labelled "12" means 12 real physical stop
 * locations fell within its pixel radius at this zoom, nothing invented and
 * nothing double-counted. It crossfades into the existing per-location dots
 * (CLUSTER_ZOOM ± CLUSTER_FADE), which themselves crossfade into individual
 * boarding poles at STOP_EXPAND_ZOOM — three honestly-labelled tiers, never a
 * silent swap of what a dot represents.
 */
const CLUSTER_ZOOM = 12;
const CLUSTER_FADE = 0.6;

/**
 * Zoom at which the stop layer EXPANDS from clustered physical stop locations
 * to the individual boarding poles that make them up.
 *
 * Below it, one dot = one place you can catch a bus. Above it, one dot = one
 * pole, so the to/from pair either side of a road separates visibly. 15 is
 * where that separation becomes legible rather than a smudge: the median pair
 * is 20.4 m apart, which is ~3 px at z14 but ~6 px at z15 and ~12 px at z16.
 *
 * The two layers crossfade across EXPAND_FADE so neither pops, and the swap is
 * an honest change of unit, not a level-of-detail trick — the count readout in
 * the corner changes with it and says which unit is on screen.
 */
const STOP_EXPAND_ZOOM = 15;
const EXPAND_FADE = 0.4;

/** Human labels for the attribute inspector (§9). Raw fixture keys are terse
 *  because they are repeated thousands of times in the payload; the popover is
 *  read by a person and has to say what the number actually means. */
const ATTR_LABELS: Record<string, string> = {
  w: "routes serving",
  m: "boarding points merged",
  mode: "mode",
  method: "clustering",
};

/** Presentation-only keys that must never surface as attributes — `t` is the
 *  landing twinkle stagger seed, not data about the stop; the `cluster*` keys
 *  are MapLibre's own bookkeeping on a cluster-source feature, not stop data
 *  (cluster bubbles never reach the popover anyway — see handleClick — but an
 *  unclustered dot from the same source carries these alongside its real
 *  properties and shouldn't show them). */
const ATTR_HIDDEN = new Set([
  "t", "name", "evidence", "sample",
  "cluster", "cluster_id", "point_count", "point_count_abbreviated",
]);

/**
 * North-indicator glyph (§9 cartographic furniture) — loads the ACTUAL
 * public/icons/north-arrow.svg file at runtime and inlines its real markup
 * (no re-authored/copied path data). That file is drawn as an opaque white
 * square with black shapes on top (no real alpha channel), so it can't
 * retint or sit transparently as an <img> on its own; `.propus-north-arrow`
 * in globals.css targets its two literal fill values (`rgb(255,255,255)` →
 * transparent, `rgb(0,0,0)` → currentColor) so the file renders as-is but
 * transparent and theme-colored. TODO(design): swap the file itself for the
 * antique two-tone (ink/inkMuted) SVG once generated — still a placeholder.
 */
function NorthArrowGlyph({ color, className }: { color: string; className?: string }) {
  const [markup, setMarkup] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/icons/north-arrow.svg")
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setMarkup(text);
      })
      .catch(() => {
        /* leave blank — furniture, not critical path */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div
      className={`propus-north-arrow ${className ?? ""}`}
      style={{ color }}
      // eslint-disable-next-line react/no-danger -- the actual file's own markup, unmodified
      dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
    />
  );
}

export interface ResultLayer {
  id: string;
  label: string;
  result: Extract<PropusResult, { kind: "map_layer" }>;
  visible: boolean;
  opacity: number; // 0..1 multiplier from the layer manager
}

export interface BaseLayerState {
  stops: boolean;
  metro: boolean;
  metroLines: boolean;
  /** ward polygons — off on landing; auto-enabled when a ward-level analysis lands */
  wards: boolean;
  /** dissolved outer city boundary (dashed) — the landing's only boundary */
  city: boolean;
}

/**
 * Stop-class glyphs (Maki, CC0 — see ATTRIBUTION.md). Monochrome SVGs are
 * rasterized once and tinted with token colors on a canvas, so the assets
 * stay black-on-transparent and the palette stays in lib/tokens.ts. The
 * disc + ring under each glyph is the existing circle layer — this mirrors
 * the QGIS styles in data/bus_icon.qml / metro_icon.qml (white disc, primary
 * ring for bus, madder ring for metro). Tints come from the ACTIVE palette so
 * the glyphs stay legible on the dark basemap (§7).
 */
const ICON_PX = 64; // rasterized at 64px, served at pixelRatio 2 (32px logical)

async function loadStopIcons(
  map: MaplibreMap,
  palette: Record<ColorToken, string>,
  theme: string
): Promise<void> {
  // Theme-suffixed ids: a flip can never serve a stale tint, whether or not
  // setStyle() preserved the previous style's images.
  const defs = [
    // bus = neutral ink roundel: theme-aware (near-black on Positron, cream on
    // Dark Matter) and hue-free, so it never collides with a metro line colour
    { id: `icon-bus-${theme}`, url: "/icons/bus.svg", color: palette.ink },
    // metro glyph rides an `ink` fill (dark in light, light in dark); `sheet`
    // is its exact inverse (white in light, dark navy in dark), so the glyph
    // stays legible on the disc in both themes
    { id: `icon-metro-${theme}`, url: "/icons/metro.svg", color: palette.sheet },
  ] as const;
  await Promise.all(
    defs.map(async ({ id, url, color }) => {
      if (map.hasImage(id)) return;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`icon failed to load: ${url}`));
        img.src = url;
      });
      // A concurrent registration may have added it while we awaited the load —
      // re-check before addImage, which throws on a duplicate id.
      if (map.hasImage(id)) return;
      const canvas = document.createElement("canvas");
      canvas.width = ICON_PX;
      canvas.height = ICON_PX;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, ICON_PX, ICON_PX);
      ctx.globalCompositeOperation = "source-in"; // tint the glyph, keep alpha
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, ICON_PX, ICON_PX);
      // Two loads that resolve in the same tick can both pass the guards (the
      // SVG is cached, so onload fires together). addImage throws on a dup, which
      // is harmless here — swallow only that specific case.
      if (map.hasImage(id)) return;
      try {
        map.addImage(id, ctx.getImageData(0, 0, ICON_PX, ICON_PX), { pixelRatio: 2 });
      } catch {
        /* already registered by a concurrent restyle — fine */
      }
    })
  );
}

interface Picked {
  lngLat: [number, number];
  props: Record<string, unknown>;
  layerLabel: string;
}

export const MapView = forwardRef<
  MapRef,
  {
    layers: ResultLayer[];
    base: BaseLayerState;
    stopsGeoJSON: GeoJSON.FeatureCollection | null;
    /** clustered physical stop LOCATIONS (Estimated); null if the crosswalk
     *  hasn't been built — the map then shows stopsGeoJSON at every zoom */
    physicalStopsGeoJSON?: GeoJSON.FeatureCollection | null;
    metroGeoJSON: GeoJSON.FeatureCollection | null;
    metroLinesGeoJSON: GeoJSON.FeatureCollection | null;
    wardsGeoJSON: GeoJSON.FeatureCollection | null;
    cityGeoJSON: GeoJSON.FeatureCollection | null;
    stopsAreSample: boolean;
    hoveredWard?: string | null;
    onHoverWard?: (name: string | null) => void;
    onPickPoint?: (lonLat: [number, number]) => void;
    pickMode?: boolean;
    interactive?: boolean;
    twinkleProgress?: number; // 0..1, landing star-chart reveal
    /** 0..1 one-shot survey-sweep pulse while computing (§6c.3) — never loops */
    sweep?: number;
    className?: string;
  }
>(function MapView(
  {
    layers,
    base,
    stopsGeoJSON,
    physicalStopsGeoJSON,
    metroGeoJSON,
    metroLinesGeoJSON,
    wardsGeoJSON,
    cityGeoJSON,
    stopsAreSample,
    hoveredWard,
    onHoverWard,
    onPickPoint,
    pickMode,
    interactive = true,
    twinkleProgress = 1,
    sweep = 0,
    className,
  },
  ref
) {
  const { theme, palette, hydrated } = useThemePalette();
  // Until the provider has reconciled `theme` (post-mount), trust the pre-paint
  // [data-theme] attribute for the basemap so a persisted-dark reload mounts
  // straight onto Dark Matter — no positron→dark flash. Safe from hydration
  // mismatch because the GL canvas renders no server DOM. After `hydrated`, the
  // seed and `theme` agree, so react-map-gl issues no extra setStyle.
  const [seededDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
  );
  const isDark = hydrated ? theme === "dark" : seededDark;
  const mapStyle = isDark ? MAP_STYLE_DARK : MAP_STYLE;

  // Resolve a result's style token against the ACTIVE palette — same token name,
  // dark ramp/ink in dark mode. This is the whole point of the two-outlet design.
  const resolve = useCallback(
    (key: string | undefined, fallback: ColorToken): string =>
      palette[(key as ColorToken) ?? fallback] ?? palette[fallback],
    [palette]
  );

  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  // right-click "copy coordinates" tooltip (Google Maps convention)
  const [rightClick, setRightClick] = useState<[number, number] | null>(null);
  const [coordsCopied, setCoordsCopied] = useState(false);
  // symbol layers mount only after the tinted glyphs are registered —
  // otherwise MapLibre logs styleimagemissing for every stop
  const [iconsReady, setIconsReady] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMapLoad = useCallback(() => setMapLoaded(true), []);

  /**
   * Compact attribution: collapsed to the bare `i` by default, opening on
   * hover so the sources are one gesture away rather than a click.
   *
   * Three things fight this, hence the observer:
   *  1. MapLibre renders the control as a native <details>, whose open state a
   *     UA stylesheet owns — CSS alone cannot reveal it on hover.
   *  2. react-map-gl mounts <AttributionControl> as a child, so the element is
   *     usually still absent at the moment `mapLoaded` flips. Querying once
   *     there finds nothing and gives up for good.
   *  3. MapLibre's own `_updateCompact()` re-applies `open` +
   *     `maplibregl-compact-show` whenever attribution data or canvas size
   *     changes, so closing it once gets silently undone later.
   *
   * So: watch the map container, bind whenever the control appears, and close
   * again on any open we did not ask for.
   */
  useEffect(() => {
    if (!mapLoaded) return;
    const container = (ref as React.RefObject<MapRef>)?.current?.getMap()?.getContainer();
    if (!container) return;

    let el: HTMLDetailsElement | null = null;
    let engaged = false; // pointer is over it, or focus is inside it

    const collapse = () => {
      if (!el) return;
      el.open = false;
      el.classList.remove("maplibregl-compact-show");
    };
    const expand = () => {
      if (!el) return;
      el.open = true;
      el.classList.add("maplibregl-compact-show");
    };
    const onEnter = () => {
      engaged = true;
      expand();
    };
    const onLeave = () => {
      // keep it open while a keyboard user is still reading inside it
      if (el?.contains(document.activeElement)) return;
      engaged = false;
      collapse();
    };

    const bind = (node: HTMLDetailsElement) => {
      if (el === node) return;
      el = node;
      node.addEventListener("mouseenter", onEnter);
      node.addEventListener("mouseleave", onLeave);
      node.addEventListener("focusin", onEnter);
      node.addEventListener("focusout", onLeave);
      collapse();
    };

    const sync = () => {
      const node = container.querySelector<HTMLDetailsElement>(".maplibregl-ctrl-attrib");
      if (node) bind(node);
      if (el && !engaged && el.open) collapse();
    };

    sync();
    // childList catches the control mounting; the attribute filter catches
    // MapLibre re-opening it (and matches nothing the canvas does)
    const obs = new MutationObserver(sync);
    obs.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "class"],
    });

    return () => {
      obs.disconnect();
      el?.removeEventListener("mouseenter", onEnter);
      el?.removeEventListener("mouseleave", onLeave);
      el?.removeEventListener("focusin", onEnter);
      el?.removeEventListener("focusout", onLeave);
    };
  }, [mapLoaded, ref]);

  // The shared map mounts full-screen on the landing, where initialViewState
  // bounds are computed before the canvas is sized and fall back to a low
  // NCR-wide zoom. Re-fit once the map has real dimensions — only on the
  // landing (non-interactive); the app drives the camera via the conductor.
  // We fit the metro-dense core (not the full DELHI_BBOX, whose square corners
  // overshoot into the NCR on wide viewports), so the network fills the frame
  // and station glyphs read. Left-padded to clear the hero text column.
  useEffect(() => {
    if (!mapLoaded || interactive) return;
    const map = (ref as React.RefObject<MapRef>)?.current?.getMap();
    map?.fitBounds(
      [
        [77.0, 28.49],
        [77.33, 28.75],
      ],
      { padding: { top: 40, bottom: 40, left: 320, right: 40 }, duration: 0 }
    );
  }, [mapLoaded, interactive, ref]);

  // (Re)register the tinted glyphs after the style loads AND whenever the theme
  // flips. Swapping mapStyle calls map.setStyle(), which drops every added image,
  // so the icons must be re-tinted for — and re-added to — the new basemap. The
  // hasImage guard inside loadStopIcons keeps the repeated `styledata` fires cheap.
  useEffect(() => {
    const map = (ref as React.RefObject<MapRef>)?.current?.getMap();
    if (!mapLoaded || !map) return;
    let cancelled = false;
    let running = false;
    setIconsReady(false);
    const register = () => {
      if (cancelled || running || !map.isStyleLoaded()) return;
      if (map.hasImage(`icon-bus-${theme}`) && map.hasImage(`icon-metro-${theme}`)) {
        setIconsReady(true);
        return;
      }
      running = true;
      loadStopIcons(map, palette, theme)
        .then(() => !cancelled && setIconsReady(true))
        .catch((err) => console.error("stop icons unavailable:", err))
        .finally(() => {
          running = false;
        });
    };
    register();
    // styledata fires during the style swap; idle is the guaranteed retry if
    // the last styledata lands before isStyleLoaded() flips true (slow sprite
    // or tile fetch). The hasImage fast-path keeps repeat fires free.
    map.on("styledata", register);
    map.on("idle", register);
    return () => {
      cancelled = true;
      map.off("styledata", register);
      map.off("idle", register);
    };
  }, [mapLoaded, theme, palette, ref]);

  // Matte basemap (TASKS.md M3): desaturate the basemap's own layer paints
  // once per loaded style. A theme flip calls setStyle → fresh style instance
  // → `styledata` refires until isStyleLoaded, when the transform lands; the
  // WeakSet inside applyMatteBasemap makes every repeat call free and
  // non-compounding. Data layers (base-*/res-*) are skipped — token hexes
  // stay exact for the choropleth ramp, metro identities, and amber.
  useEffect(() => {
    const map = (ref as React.RefObject<MapRef>)?.current?.getMap();
    if (!mapLoaded || !map) return;
    const apply = () => applyMatteBasemap(map);
    apply();
    map.on("styledata", apply);
    map.on("idle", apply);
    return () => {
      map.off("styledata", apply);
      map.off("idle", apply);
    };
  }, [mapLoaded, theme, ref]);

  // Keep the GL canvas filling its container on ANY size change — not just
  // window resize (BUGS.md B4 was about window resize specifically, but a
  // ResizeObserver on the container also covers the chat-pane drag-resize,
  // which changes the map's width without ever firing a window resize
  // event: without this the canvas kept a stale width during a drag).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      (ref as React.RefObject<MapRef>)?.current?.getMap()?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  // Escape dismisses the right-click "copy coordinates" tooltip (Google Maps convention)
  useEffect(() => {
    if (!rightClick) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setRightClick(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rightClick]);

  // full fixture carries per-stop route counts; the sample does not — without
  // them the app falls back to the single all-stops layer (no invented keyness)
  const hasStopWeights = useMemo(
    () =>
      !!stopsGeoJSON?.features.some(
        (f) => (((f.properties ?? {}) as Record<string, unknown>).w as number) > 0
      ),
    [stopsGeoJSON]
  );

  /**
   * True when the map is showing two stop tiers and the boarding-point layer
   * is therefore the ZOOMED-IN half of a crossfade rather than the only layer.
   * The landing keeps its single flat star chart.
   */
  const expandsToPoles = !!physicalStopsGeoJSON && interactive;

  /** Live zoom, tracked only to label WHICH stop unit is currently drawn.
   *  Set from the map's own camera rather than assumed, so the readout can
   *  never disagree with what the layers are doing. */
  const [zoom, setZoom] = useState<number | null>(null);

  // §6b: every camera move respects reduced motion — cluster-bubble
  // click-to-zoom jumps instantly instead of easing when set.
  const reducedMotion = useReducedMotion();

  /**
   * Ramps a boarding-point layer in at STOP_EXPAND_ZOOM when it is the
   * zoomed-in half of the crossfade, and leaves its opacity untouched
   * otherwise — so a missing crosswalk degrades to the previous single-layer
   * behaviour instead of a map with no stops on it.
   */
  const poleOpacity = useCallback(
    (base: number) =>
      (expandsToPoles
        ? [
            "interpolate", ["linear"], ["zoom"],
            STOP_EXPAND_ZOOM - EXPAND_FADE, 0,
            STOP_EXPAND_ZOOM + EXPAND_FADE, base,
          ]
        : base) as unknown as number,
    [expandsToPoles]
  );

  const interactiveLayerIds = useMemo(() => {
    const ids: string[] = [];
    if (base.stops && stopsGeoJSON) {
      ids.push("base-stops");
      if (interactive && hasStopWeights) ids.push("base-stops-minor");
    }
    // clustered locations are inspectable too — a user zoomed out should still
    // be able to click a dot and read what it stands for
    if (base.stops && physicalStopsGeoJSON && interactive) {
      ids.push("base-physical-stops");
      if (hasStopWeights) ids.push("base-physical-stops-minor");
      // area-cluster bubbles (§ CLUSTER_ZOOM) — clicking one zooms toward its
      // members rather than opening the attribute popover (handleClick)
      ids.push("base-stops-cluster-circles", "base-stops-cluster-unclustered");
    }
    if (base.metro && metroGeoJSON) ids.push("base-metro", "base-metro-minor");
    if (base.metroLines && metroLinesGeoJSON) ids.push("base-metro-lines");
    if (base.wards && wardsGeoJSON) ids.push("base-wards-fill");
    for (const l of layers)
      if (l.visible)
        ids.push(
          l.result.layer === "points"
            ? `res-${l.id}-circle`
            : l.result.layer === "lines"
              ? `res-${l.id}-lines`
              : `res-${l.id}-fill`
        );
    return ids;
  }, [base, layers, stopsGeoJSON, physicalStopsGeoJSON, metroGeoJSON, metroLinesGeoJSON, wardsGeoJSON, interactive, hasStopWeights]);

  // curated line colours from the fixture (pipeline/process_metro_lines.py).
  // Single source for both the line paint and the station rings; token palette
  // remains the fallback when the fixture is absent.
  const lineColours = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of metroLinesGeoJSON?.features ?? []) {
      const p = (f.properties ?? {}) as Record<string, unknown>;
      if (typeof p.line === "string" && typeof p.colour === "string") m[p.line] = p.colour;
    }
    return m;
  }, [metroLinesGeoJSON]);

  const lineColourExpr = useCallback(
    (fallback: string): unknown =>
      [
        "match",
        ["get", "line"],
        ...Object.entries(metroLineTokens).flatMap(([value, token]) => [
          value,
          lineColours[value] ?? palette[token],
        ]),
        ...Object.entries(lineColours)
          .filter(([value]) => !(value in metroLineTokens))
          .flatMap(([value, colour]) => [value, colour]),
        fallback,
      ],
    [lineColours, palette]
  );

  // hover tooltip for metro lines — cleaned `name` from the fixture
  const [hoverLine, setHoverLine] = useState<{
    lngLat: [number, number];
    name: string;
    colour?: string;
  } | null>(null);

  const handleMove = useCallback(
    (e: MapLayerMouseEvent) => {
      setCursor([e.lngLat.lng, e.lngLat.lat]);
      const lf = e.features?.find((f) => f.layer.id === "base-metro-lines");
      setHoverLine(
        lf
          ? {
              lngLat: [e.lngLat.lng, e.lngLat.lat],
              name: String(lf.properties?.name ?? ""),
              colour:
                typeof lf.properties?.colour === "string" ? lf.properties.colour : undefined,
            }
          : null
      );
      if (!onHoverWard || !wardsGeoJSON) return;
      const f = e.features?.find((f) => f.layer.id === "base-wards-fill");
      onHoverWard(f ? String(f.properties?.__name ?? "") || null : null);
    },
    [onHoverWard, wardsGeoJSON]
  );

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      setRightClick(null);
      if (pickMode && onPickPoint) {
        onPickPoint([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // queryRenderedFeatures (what populates e.features) orders results by
      // paint order — but paint order here is an accident of when each async
      // fixture resolved (wards can mount, and land on top, after the stops
      // layers already exist), not a deliberate stacking choice. A ward fill
      // covering the whole city must never out-rank a stop dot or cluster
      // bubble just because it happened to load second, so pick the most
      // specific geometry under the cursor rather than blindly the topmost.
      const geomRank = (type: string) => (type === "circle" || type === "symbol" ? 0 : type === "line" ? 1 : 2);
      const f = e.features?.slice().sort((a, b) => geomRank(a.layer.type) - geomRank(b.layer.type))[0];
      if (!f) {
        setPicked(null);
        return;
      }
      // A cluster bubble is a display aggregation, not an inspectable stop —
      // there's no single set of attributes it could show. Click zooms toward
      // its members instead, the standard marker-cluster interaction. A dot on
      // "-unclustered" is a real, lone physical location (same schema as the
      // physical tier below it) and falls through to the normal popover.
      if (f.layer.id === "base-stops-cluster-circles") {
        const clusterId = f.properties?.cluster_id;
        const map = (ref as React.RefObject<MapRef>)?.current?.getMap();
        const source = map?.getSource("base-stops-cluster-src") as GeoJSONSource | undefined;
        if (!map || !source || typeof clusterId !== "number") return;
        source
          .getClusterExpansionZoom(clusterId)
          .then((zoom) =>
            reducedMotion
              ? map.jumpTo({ center: e.lngLat, zoom: zoom + 0.2 })
              : map.easeTo({ center: e.lngLat, zoom: zoom + 0.2, duration: 500 })
          )
          .catch(() => {});
        return;
      }
      setPicked({
        lngLat: [e.lngLat.lng, e.lngLat.lat],
        props: (f.properties ?? {}) as Record<string, unknown>,
        layerLabel: f.layer.id,
      });
    },
    [pickMode, onPickPoint, ref, reducedMotion]
  );

  // right-click → Google Maps-style "copy coordinates" tooltip
  const handleContextMenu = useCallback((e: MapLayerMouseEvent) => {
    e.originalEvent.preventDefault(); // suppress the browser's native context menu
    setPicked(null);
    setCoordsCopied(false);
    setRightClick([e.lngLat.lng, e.lngLat.lat]);
  }, []);

  const copyCoords = useCallback(async () => {
    if (!rightClick) return;
    const text = `${rightClick[1].toFixed(6)}, ${rightClick[0].toFixed(6)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCoordsCopied(true);
    } catch {
      /* clipboard unavailable (permissions/insecure context) — tooltip stays, no crash */
    }
  }, [rightClick]);

  const exportPNG = useCallback(() => {
    const map = (ref as React.RefObject<MapRef>)?.current?.getMap();
    if (!map) return;
    const a = document.createElement("a");
    a.href = map.getCanvas().toDataURL("image/png");
    a.download = "propus-map.png";
    a.click();
  }, [ref]);

  // landing star-chart: opacity gated per-feature by its random `t`
  const twinkleOpacity =
    twinkleProgress >= 1
      ? 0.75
      : ([
          "*",
          0.75,
          ["min", 1, ["max", 0, ["/", ["-", twinkleProgress, ["get", "t"]], 0.2]]],
        ] as unknown as number);

  return (
    <div ref={containerRef} className={`relative h-full w-full ${className ?? ""}`}>
      <Map
        ref={ref}
        mapStyle={mapStyle}
        // Positron ↔ Dark Matter share no layers, so diffing a theme swap buys
        // nothing — and a diffed setStyle PATCHES the existing style instance,
        // which would both skip the matte re-application (per-instance guard in
        // applyMatteBasemap) and leave the swapped basemap undesaturated. A
        // full reload gives a fresh style instance and a clean reapply.
        styleDiffing={false}
        // frame the MCD wards extent (validated GTFS bbox), not the wider NCR
        initialViewState={{
          bounds: [DELHI_BBOX.west, DELHI_BBOX.south, DELHI_BBOX.east, DELHI_BBOX.north],
          fitBoundsOptions: { padding: 24 },
        }}
        attributionControl={false}
        dragPan={interactive}
        scrollZoom={interactive}
        doubleClickZoom={interactive}
        touchZoomRotate={interactive}
        keyboard={interactive}
        dragRotate={false}
        pitchWithRotate={false}
        interactiveLayerIds={interactive ? interactiveLayerIds : undefined}
        onLoad={handleMapLoad}
        onMouseMove={interactive ? handleMove : undefined}
        onClick={interactive ? handleClick : undefined}
        onContextMenu={interactive ? handleContextMenu : undefined}
        onMoveStart={() => setRightClick(null)}
        onZoom={expandsToPoles ? (e) => setZoom(e.viewState.zoom) : undefined}
        cursor={pickMode ? "crosshair" : undefined}
        preserveDrawingBuffer
        style={{ width: "100%", height: "100%" }}
      >
        <AttributionControl
          compact
          position="bottom-right"
          // The single home for source credit now that the landing footer is
          // gone. Wards are included because DataMeet ships CC BY-SA 2.5 IN and
          // OpenCity ODC-By — attribution there is a licence condition, not a
          // courtesy (see ATTRIBUTION.md).
          customAttribution="© OpenStreetMap contributors · © OTD Delhi · © DMRC · wards © OpenCity/DataMeet"
        />
        {interactive && <ScaleControl position="bottom-right" maxWidth={120} />}
        {interactive && <NavigationControl position="bottom-right" showCompass={false} />}

        {/* ---- base data layers (all real) ---- */}
        {cityGeoJSON && base.city && (
          <Source id="base-city-src" type="geojson" data={cityGeoJSON}>
            {/* dissolved MCD outline — the landing's only boundary (dashed) */}
            <Layer
              id="base-city-line"
              source="base-city-src"
              type="line"
              paint={{
                "line-color": palette.celestialMuted,
                "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.4, 12, 2] as unknown as number,
                "line-dasharray": [3, 2.5],
                "line-opacity": 0.8,
              }}
            />
          </Source>
        )}

        {wardsGeoJSON && base.wards && (
          <Source id="base-wards" type="geojson" data={wardsGeoJSON}>
            <Layer
              id="base-wards-fill"
              type="fill"
              // U4: survey sweep — the instrument looks at the extent ONCE while
              // computing (§6c.3); `sweep` pulses 0→1→0, never loops.
              paint={{ "fill-color": palette.ramp1, "fill-opacity": 0.06 + sweep * 0.12 }}
            />
            <Layer
              id="base-wards-line"
              type="line"
              paint={{ "line-color": palette.celestialMuted, "line-width": 0.6, "line-opacity": 0.4 }}
            />
            <Layer
              id="base-wards-hover"
              type="line"
              filter={["==", ["get", "__name"], hoveredWard ?? " "]}
              // U5: madder is the selection ink (§4) — hovered/selected wards & rows
              paint={{ "line-color": palette.madder, "line-width": 2 }}
            />
          </Source>
        )}

        {/* Zoomed-OUT area clustering — real MapLibre `cluster: true` bubbles
            over the same physical-location tier below, purely so a busy
            corridor reads as "12 stops here" instead of a smudge of 12
            unreadable dots. This is a display technique, not a new data
            tier: point_count is an exact count of real physical locations
            within the bubble's pixel radius at this zoom, nothing modelled.
            Click a bubble to zoom toward its members (getClusterExpansionZoom).
            Fades out as the per-location dots below fade in (§ CLUSTER_ZOOM). */}
        {physicalStopsGeoJSON && base.stops && interactive && (
          <Source
            id="base-stops-cluster-src"
            type="geojson"
            data={physicalStopsGeoJSON}
            cluster={true}
            clusterRadius={50}
            clusterMaxZoom={Math.ceil(CLUSTER_ZOOM + CLUSTER_FADE)}
          >
            <Layer
              id="base-stops-cluster-circles"
              source="base-stops-cluster-src"
              type="circle"
              maxzoom={CLUSTER_ZOOM + CLUSTER_FADE}
              filter={["has", "point_count"]}
              paint={{
                "circle-radius": [
                  "step", ["get", "point_count"],
                  9,
                  10, 13,
                  50, 17,
                  200, 22,
                ],
                "circle-color": [
                  "step", ["get", "point_count"],
                  palette.celestialMuted,
                  10, palette.primary,
                  50, palette.primaryInk,
                ],
                "circle-stroke-color": palette.sheet,
                "circle-stroke-width": 1.5,
                "circle-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 0.85,
                  CLUSTER_ZOOM + CLUSTER_FADE, 0,
                ],
                "circle-stroke-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 1,
                  CLUSTER_ZOOM + CLUSTER_FADE, 0,
                ],
              }}
            />
            <Layer
              id="base-stops-cluster-count"
              source="base-stops-cluster-src"
              type="symbol"
              maxzoom={CLUSTER_ZOOM + CLUSTER_FADE}
              filter={["has", "point_count"]}
              layout={{
                "text-field": ["get", "point_count_abbreviated"],
                "text-font": ["Noto Sans Regular"],
                "text-size": 11,
              }}
              paint={{
                "text-color": palette.onCelestial,
                "text-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 1,
                  CLUSTER_ZOOM + CLUSTER_FADE, 0,
                ],
              }}
            />
            {/* A physical location far enough from any neighbour to stand alone
                still needs to render at overview zoom — same dot style as the
                per-location tier below, so there's no visual seam at the swap. */}
            <Layer
              id="base-stops-cluster-unclustered"
              source="base-stops-cluster-src"
              type="circle"
              maxzoom={CLUSTER_ZOOM + CLUSTER_FADE}
              filter={["!", ["has", "point_count"]]}
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.6, 12, 3.5],
                "circle-color": palette.celestialMuted,
                "circle-stroke-color": palette.sheet,
                "circle-stroke-width": 1,
                "circle-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 0.8,
                  CLUSTER_ZOOM + CLUSTER_FADE, 0,
                ],
              }}
            />
          </Source>
        )}

        {/* Clustered PHYSICAL stop locations — the zoomed-out unit. One dot per
            place you can board, so the map's dot count matches the ward
            metrics instead of showing 2.6x more. Fades out as the individual
            poles fade in at STOP_EXPAND_ZOOM; only rendered when the crosswalk
            exists, and only in the app (the landing star chart is its own
            composition). */}
        {physicalStopsGeoJSON && base.stops && interactive && (
          <Source id="base-physical-stops-src" type="geojson" data={physicalStopsGeoJSON}>
            <Layer
              id="base-physical-stops"
              source="base-physical-stops-src"
              type="circle"
              minzoom={CLUSTER_ZOOM - CLUSTER_FADE}
              maxzoom={STOP_EXPAND_ZOOM + EXPAND_FADE}
              filter={
                hasStopWeights
                  ? [">=", ["coalesce", ["get", "w"], 0], KEY_STOP_MIN_ROUTES]
                  : ["all"]
              }
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.6, 12, 3.5, 15, 8],
                "circle-color": [
                  "interpolate", ["linear"], ["zoom"],
                  11.5, palette.celestialMuted,
                  12.5, palette.sheet,
                ],
                "circle-stroke-color": palette.ink,
                "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1.2, 15, 2],
                // Fades IN as the cluster bubbles below fade out (§ CLUSTER_ZOOM),
                // then back OUT as individual boarding poles take over at
                // STOP_EXPAND_ZOOM — one dot is only ever one thing at a time.
                "circle-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 0,
                  CLUSTER_ZOOM + CLUSTER_FADE, 0.8,
                  STOP_EXPAND_ZOOM - EXPAND_FADE, 0.8,
                  STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                ],
                "circle-stroke-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  CLUSTER_ZOOM - CLUSTER_FADE, 0,
                  CLUSTER_ZOOM + CLUSTER_FADE, 1,
                  STOP_EXPAND_ZOOM - EXPAND_FADE, 1,
                  STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                ],
              }}
            />
            {hasStopWeights && (
              <Layer
                id="base-physical-stops-minor"
                source="base-physical-stops-src"
                type="circle"
                minzoom={CLUSTER_ZOOM - CLUSTER_FADE}
                maxzoom={STOP_EXPAND_ZOOM + EXPAND_FADE}
                filter={["<", ["coalesce", ["get", "w"], 0], KEY_STOP_MIN_ROUTES]}
                paint={{
                  "circle-radius": ["interpolate", ["linear"], ["zoom"], 10.8, 1.6, 12, 3.5, 15, 8],
                  "circle-color": [
                    "interpolate", ["linear"], ["zoom"],
                    11.5, palette.celestialMuted,
                    12.5, palette.sheet,
                  ],
                  "circle-stroke-color": palette.ink,
                  "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1.2, 15, 2],
                  "circle-opacity": [
                    "interpolate", ["linear"], ["zoom"],
                    CLUSTER_ZOOM - CLUSTER_FADE, 0,
                    CLUSTER_ZOOM + CLUSTER_FADE, 0.75,
                    STOP_EXPAND_ZOOM - EXPAND_FADE, 0.75,
                    STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                  ],
                  "circle-stroke-opacity": [
                    "interpolate", ["linear"], ["zoom"],
                    CLUSTER_ZOOM - CLUSTER_FADE, 0,
                    CLUSTER_ZOOM + CLUSTER_FADE, 1,
                    STOP_EXPAND_ZOOM - EXPAND_FADE, 1,
                    STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                  ],
                }}
              />
            )}
            {/* "2" badge on merged locations only (m > 1) — tells the reader
                this dot stands for more than one pole BEFORE they zoom, so the
                collapse is visible rather than hidden. Suppressed below z13
                where the labels would collide into noise. */}
            <Layer
              id="base-physical-stops-count"
              source="base-physical-stops-src"
              type="symbol"
              minzoom={13}
              maxzoom={STOP_EXPAND_ZOOM + EXPAND_FADE}
              filter={[">", ["coalesce", ["get", "m"], 1], 1]}
              layout={{
                "text-field": ["to-string", ["get", "m"]],
                "text-font": ["Noto Sans Regular"],
                "text-size": 9,
                "text-offset": [0.9, -0.9],
                "text-allow-overlap": false,
                "text-ignore-placement": false,
              }}
              paint={{
                "text-color": palette.ink,
                "text-halo-color": palette.sheet,
                "text-halo-width": 1.2,
                "text-opacity": [
                  "interpolate", ["linear"], ["zoom"],
                  13, 0,
                  13.6, 0.75,
                  STOP_EXPAND_ZOOM - EXPAND_FADE, 0.75,
                  STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                ],
              }}
            />
            {/* The same QML bus glyph crossfade as the pole layer, but for the
                clustered band, so the 12.5 -> 15 range keeps its designed
                symbology instead of staying bare dots until the expand. */}
            {iconsReady && (
              <Layer
                id="base-physical-stops-icon"
                source="base-physical-stops-src"
                type="symbol"
                minzoom={12.5}
                maxzoom={STOP_EXPAND_ZOOM + EXPAND_FADE}
                layout={{
                  "icon-image": `icon-bus-${theme}`,
                  "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.3, 15, 0.42],
                  "icon-allow-overlap": true,
                }}
                paint={{
                  "icon-opacity": [
                    "interpolate", ["linear"], ["zoom"],
                    12.5, 0,
                    13, 1,
                    STOP_EXPAND_ZOOM - EXPAND_FADE, 1,
                    STOP_EXPAND_ZOOM + EXPAND_FADE, 0,
                  ],
                }}
              />
            )}
          </Source>
        )}

        {stopsGeoJSON && base.stops && (
          <Source id="base-stops-src" type="geojson" data={stopsGeoJSON}>
            {/* Star-chart dots at overview zoom; crossfade into the QML bus
                symbol (white disc, primary ring — data/bus_icon.qml) as the
                city resolves. In the app, overview zoom shows only well-served
                stops (w = distinct routes, Observed) — 10.5k dots at z10 read
                as noise; the landing keeps the full star chart. */}
            {interactive && hasStopWeights ? (
              <>
                <Layer
                  id="base-stops"
                  source="base-stops-src"
                  type="circle"
                  filter={[">=", ["coalesce", ["get", "w"], 0], KEY_STOP_MIN_ROUTES]}
                  paint={{
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.6, 12, 3.5, 15, 8],
                    "circle-color": [
                      "interpolate", ["linear"], ["zoom"],
                      11.5, palette.celestialMuted,
                      12.5, palette.sheet,
                    ],
                    "circle-stroke-color": palette.ink,
                    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1.2, 15, 2],
                    "circle-opacity": poleOpacity(0.8),
                  }}
                />
                <Layer
                  id="base-stops-minor"
                  source="base-stops-src"
                  type="circle"
                  minzoom={10.8}
                  filter={["<", ["coalesce", ["get", "w"], 0], KEY_STOP_MIN_ROUTES]}
                  paint={{
                    "circle-radius": ["interpolate", ["linear"], ["zoom"], 10.8, 1.6, 12, 3.5, 15, 8],
                    "circle-color": [
                      "interpolate", ["linear"], ["zoom"],
                      11.5, palette.celestialMuted,
                      12.5, palette.sheet,
                    ],
                    "circle-stroke-color": palette.ink,
                    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1.2, 15, 2],
                    "circle-opacity": expandsToPoles
                      ? poleOpacity(0.75)
                      : (["interpolate", ["linear"], ["zoom"], 10.8, 0, 11.6, 0.75] as unknown as number),
                  }}
                />
              </>
            ) : (
              <Layer
                id="base-stops"
                type="circle"
                paint={{
                  "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 12, 3.5, 15, 8],
                  "circle-color": [
                    "interpolate", ["linear"], ["zoom"],
                    11.5, palette.celestialMuted,
                    12.5, palette.sheet,
                  ],
                  "circle-stroke-color": palette.ink,
                  "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0, 12.5, 1.2, 15, 2],
                  "circle-opacity": twinkleOpacity,
                }}
              />
            )}
            {/* When the map expands to poles, the bus glyph must not start at
                12.5 — the clustered tier still owns the map until
                STOP_EXPAND_ZOOM, and drawing both would show one icon per pole
                on top of one dot per location: the same stop twice. */}
            {iconsReady && (
              <Layer
                id="base-stops-icon"
                source="base-stops-src"
                type="symbol"
                minzoom={expandsToPoles ? STOP_EXPAND_ZOOM - EXPAND_FADE : 12.5}
                layout={{
                  "icon-image": `icon-bus-${theme}`,
                  "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.3, 15, 0.42],
                  "icon-allow-overlap": true,
                }}
                paint={{
                  "icon-opacity": expandsToPoles
                    ? ([
                        "interpolate", ["linear"], ["zoom"],
                        STOP_EXPAND_ZOOM - EXPAND_FADE, 0,
                        STOP_EXPAND_ZOOM + EXPAND_FADE, 1,
                      ] as unknown as number)
                    : (["interpolate", ["linear"], ["zoom"], 12.5, 0, 13, 1] as unknown as number),
                }}
              />
            )}
          </Source>
        )}

        {metroLinesGeoJSON && base.metroLines && (
          <Source id="base-metro-lines-src" type="geojson" data={metroLinesGeoJSON}>
            {/* One feature per line from the curated shapefile fixture; the
                paint reads the feature's own `colour` (data-driven identity,
                §3.4 analog), token match as fallback. Drawn above the bus
                dust, below station roundels. */}
            <Layer
              id="base-metro-lines"
              type="line"
              layout={{ "line-cap": "round", "line-join": "round" }}
              paint={{
                "line-color": [
                  "coalesce",
                  ["get", "colour"],
                  lineColourExpr(palette.celestialMuted),
                ] as unknown as string,
                "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.2, 12, 3, 15, 4.5] as unknown as number,
                "line-opacity": 0.9,
              }}
            />
          </Source>
        )}

        {metroGeoJSON && base.metro && (
          <Source id="base-metro-src" type="geojson" data={metroGeoJSON}>
            {/* Solid `ink` disc — dark in light mode, light in dark mode — so
                the marker always pops against the basemap, with the metro line's
                colour on the OUTLINE for identity. Interchanges (2+ lines) are
                larger with a neutral casing opposite the fill. The `sheet` glyph
                (inverse of `ink`) sits legibly on the disc in both themes. */}
            <Layer
              id="base-metro-minor"
              source="base-metro-src"
              type="circle"
              minzoom={10.5}
              filter={["!=", ["get", "interchange"], true]}
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 10.5, 4, 12, 6.5, 15, 9.5],
                "circle-color": palette.ink,
                // curated line colour on the outline = station's line identity
                "circle-stroke-color": lineColourExpr(palette.celestialMuted) as string,
                "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10.5, 1.6, 12, 2.4, 15, 3.2],
                "circle-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.2, 1],
                "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], 10.5, 0, 11.2, 1],
              }}
            />
            <Layer
              id="base-metro"
              source="base-metro-src"
              type="circle"
              filter={["==", ["get", "interchange"], true]}
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 6.5, 12, 9.5, 15, 13.5],
                "circle-color": palette.ink,
                // casing opposite the fill (sheet) — a clean halo in both modes
                "circle-stroke-color": palette.sheet,
                "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 2, 12, 3, 15, 4],
              }}
            />
            {iconsReady && (
              <>
                {/* Interchange M glyph shows from the city/landing zoom (only 23
                    key stations — no clutter), so metro reads as metro on the
                    landing. `sheet` (inverse of the `ink` fill) stays legible on
                    the disc in either theme. */}
                <Layer
                  id="base-metro-icon"
                  source="base-metro-src"
                  type="symbol"
                  minzoom={9.8}
                  filter={["==", ["get", "interchange"], true]}
                  layout={{
                    "icon-image": `icon-metro-${theme}`,
                    "icon-size": ["interpolate", ["linear"], ["zoom"], 9.8, 0.4, 13, 0.46, 15, 0.54],
                    "icon-allow-overlap": true,
                  }}
                  paint={{
                    "icon-opacity": ["interpolate", ["linear"], ["zoom"], 9.8, 0, 10.4, 1],
                  }}
                />
                {/* single-line glyphs join at street zoom, where the dots are
                    large enough and there's room for every station's M */}
                <Layer
                  id="base-metro-icon-minor"
                  source="base-metro-src"
                  type="symbol"
                  minzoom={12.5}
                  filter={["!=", ["get", "interchange"], true]}
                  layout={{
                    "icon-image": `icon-metro-${theme}`,
                    "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.3, 15, 0.48],
                    "icon-allow-overlap": true,
                  }}
                  paint={{
                    "icon-opacity": ["interpolate", ["linear"], ["zoom"], 12.5, 0, 13, 1],
                  }}
                />
              </>
            )}
          </Source>
        )}

        {/* ---- result layers (typed contract only — never raw SQL) ---- */}
        {layers.map((l) => {
          if (!l.visible) return null;
          const r = l.result;
          const fill = resolve(r.style.fillToken, "primary");
          const line = resolve(r.style.lineToken, "celestial");
          const baseOp = (r.style.opacity ?? 0.5) * l.opacity;
          return (
            <Source key={l.id} id={`res-${l.id}`} type="geojson" data={r.geojson}>
              {(r.layer === "choropleth" || r.layer === "buffer" || r.layer === "hex3d") && (
                <>
                  {r.layer === "choropleth" && (
                    /* halo: wide blurred edge in the fill colour — the glow
                       that marks highlighted wards. Static paint; the reveal
                       choreography's opacity ramp animates it in (no loops). */
                    <Layer
                      id={`res-${l.id}-halo`}
                      source={`res-${l.id}`}
                      type="line"
                      filter={["==", ["geometry-type"], "Polygon"]}
                      paint={{
                        "line-color": fill,
                        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 5, 12, 9] as unknown as number,
                        "line-blur": 5,
                        "line-opacity": Math.min(1, baseOp * 1.4),
                      }}
                    />
                  )}
                  <Layer
                    id={`res-${l.id}-fill`}
                    source={`res-${l.id}`}
                    type="fill"
                    filter={["==", ["geometry-type"], "Polygon"]}
                    paint={{ "fill-color": fill, "fill-opacity": baseOp }}
                  />
                  <Layer
                    id={`res-${l.id}-line`}
                    source={`res-${l.id}`}
                    type="line"
                    filter={["==", ["geometry-type"], "Polygon"]}
                    paint={{
                      "line-color": line,
                      "line-width": r.layer === "buffer" ? 2 : 1.2,
                      "line-opacity": Math.min(1, baseOp * 2),
                      ...(r.layer === "buffer" ? { "line-dasharray": [1, 0] } : {}),
                    }}
                  />
                  {r.layer === "buffer" && r.style.bloomRing !== false && (
                    <Layer
                      id={`res-${l.id}-ring`}
                      source={`res-${l.id}`}
                      type="line"
                      filter={["==", ["geometry-type"], "Polygon"]}
                      paint={{
                        "line-color": line,
                        "line-width": 1.2,
                        "line-opacity": Math.min(1, baseOp * 1.6),
                        "line-dasharray": [2, 2],
                        "line-offset": 6,
                      }}
                    />
                  )}
                </>
              )}
              {r.layer === "lines" && (
                <Layer
                  id={`res-${l.id}-lines`}
                  source={`res-${l.id}`}
                  type="line"
                  paint={{
                    // colorProperty (e.g. metro_line = "PINK") picks the DMRC
                    // identity token per feature; unmatched values fall back to
                    // lineToken. Data decides the color, tokens supply the hex.
                    "line-color": r.style.colorProperty
                      ? ([
                          "match",
                          ["get", r.style.colorProperty],
                          ...Object.entries(metroLineTokens).flatMap(([value, token]) => [
                            value,
                            palette[token],
                          ]),
                          line,
                        ] as unknown as string)
                      : line,
                    "line-width": 2.5,
                    "line-opacity": baseOp * 2,
                  }}
                />
              )}
              {/* point features (candidate station, catchment centre, result
                  stops) — a bright cyan cursor ring that reads on both basemaps,
                  with an `ink` centre dot that flips light/dark by theme so it
                  stays legible against the ring. Cyan, not amber: amber is the
                  alert scalpel (§3.4) and must not double as a cursor.
                  A point result that names a fillToken (hot stops → "alert")
                  is data, not a cursor: a larger disc in that token with a
                  sheet-coloured edge, so it separates from the navy clusters
                  and metro glyphs underneath. */}
              <Layer
                id={`res-${l.id}-circle`}
                source={`res-${l.id}`}
                type="circle"
                filter={["==", ["geometry-type"], "Point"]}
                paint={
                  r.style.fillToken
                    ? {
                        "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 7, 14, 10] as unknown as number,
                        "circle-color": fill,
                        "circle-stroke-color": palette.sheet,
                        "circle-stroke-width": 2.5,
                        "circle-opacity": l.opacity,
                        "circle-stroke-opacity": l.opacity,
                      }
                    : {
                        "circle-radius": 6.5,
                        "circle-color": palette.ink,
                        "circle-stroke-color": palette.cursor,
                        "circle-stroke-width": 4,
                        "circle-opacity": l.opacity,
                        "circle-stroke-opacity": l.opacity,
                      }
                }
              />
            </Source>
          );
        })}

        {/* hover tooltip: cleaned line name from the fixture, colour chip */}
        {hoverLine && !picked && (
          <Popup
            longitude={hoverLine.lngLat[0]}
            latitude={hoverLine.lngLat[1]}
            closeButton={false}
            closeOnClick={false}
            offset={12}
            maxWidth="200px"
          >
            <div className="flex items-center gap-1.5 px-2 py-1">
              {hoverLine.colour && (
                <span
                  aria-hidden
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{ background: hoverLine.colour }}
                />
              )}
              <span className="text-xs text-ink">{hoverLine.name}</span>
            </div>
          </Popup>
        )}

        {/* ---- attribute inspection (§9) ---- */}
        {picked && (
          <Popup
            longitude={picked.lngLat[0]}
            latitude={picked.lngLat[1]}
            onClose={() => setPicked(null)}
            closeOnClick={false}
            maxWidth="280px"
          >
            <div className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">
                  {String(picked.props.name ?? picked.props.__name ?? "Feature")}
                </span>
                {typeof picked.props.evidence === "string" && (
                  <EvidenceTag evidence={picked.props.evidence as Evidence} />
                )}
              </div>
              <dl className="mt-1.5 space-y-0.5 text-xs max-h-40 overflow-auto">
                {Object.entries(picked.props)
                  .filter(([k]) => !k.startsWith("__") && !ATTR_HIDDEN.has(k))
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3">
                      <dt className="text-inkMuted">{ATTR_LABELS[k] ?? k}</dt>
                      <dd className="font-mono tabular-nums text-ink">{String(v)}</dd>
                    </div>
                  ))}
                {/* A merged dot has to explain itself on inspection — otherwise
                    the reader has no way to tell that one dot is standing in
                    for two real poles, which is the whole basis of the count. */}
                {typeof picked.props.m === "number" && picked.props.m > 1 && (
                  <p className="pt-1 text-xs text-inkFaint">
                    {picked.props.m} boarding points (typically the two sides of the
                    road) merged into one stop location. Zoom past z{STOP_EXPAND_ZOOM} to
                    see them separately.
                  </p>
                )}
                {picked.props.sample === true && (
                  <p className="pt-1 text-xs text-inkFaint">
                    From the committed real-data sample — run npm run fixtures for the
                    full stop set.
                  </p>
                )}
              </dl>
            </div>
          </Popup>
        )}

        {/* ---- right-click "copy coordinates" tooltip (Google Maps convention) ---- */}
        {rightClick && (
          <Popup
            longitude={rightClick[0]}
            latitude={rightClick[1]}
            closeButton={false}
            closeOnClick={false}
            offset={4}
            anchor="left"
            className="propus-coord-popup"
          >
            <button
              type="button"
              onClick={copyCoords}
              className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-xs tabular-nums whitespace-nowrap rounded-md"
              // Inverted per theme, using the fixed pair (not the theme-resolved
              // palette, whose `celestial` itself goes near-black in dark mode
              // and would blend into the Dark Matter basemap either way): dark
              // navy chip on the light basemap, light cream chip on the dark
              // basemap. Both directions hold ~15:1 text contrast and a hairline
              // border for the WCAG 1.4.11 3:1 UI-component edge.
              style={{
                background: isDark ? colors.onCelestial : colors.celestial,
                color: isDark ? colors.celestial : colors.onCelestial,
                border: `1px solid ${isDark ? colors.celestialMuted : colors.onCelestialMuted}66`,
              }}
              aria-label={`Copy coordinates ${rightClick[1].toFixed(6)}, ${rightClick[0].toFixed(6)}`}
            >
              {coordsCopied ? (
                "Copied"
              ) : (
                <>
                  {rightClick[1].toFixed(6)}, {rightClick[0].toFixed(6)}
                  <span style={{ color: isDark ? colors.celestialMuted : colors.onCelestialMuted }}>
                    · copy
                  </span>
                </>
              )}
            </button>
          </Popup>
        )}
      </Map>

      {/* ---- furniture overlays ---- */}
      {interactive && (
        <>
          <div
            className="absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-xs text-inkMuted bg-vellum/85 border border-border rounded px-1.5 py-0.5 tabular-nums"
            aria-label="Cursor coordinates, WGS84"
          >
            {cursor
              ? `${cursor[1].toFixed(5)}°N ${cursor[0].toFixed(5)}°E · EPSG:4326`
              : "— · EPSG:4326"}
          </div>

          {/* ---- stop-unit readout (§9 GIS credibility) ----
              The dot count on screen changes meaning at STOP_EXPAND_ZOOM, and a
              silent change of unit is exactly the kind of thing that costs
              trust. This states the unit, the count, and its evidence class, so
              a reader always knows whether a dot is a place or a pole. */}
          {expandsToPoles && base.stops && (() => {
            const poles = (zoom ?? 0) >= STOP_EXPAND_ZOOM;
            const n = poles
              ? stopsGeoJSON?.features.length ?? 0
              : physicalStopsGeoJSON?.features.length ?? 0;
            return (
              <div
                className="absolute bottom-2 left-2 font-mono text-xs text-inkMuted bg-vellum/85 border border-border rounded px-1.5 py-0.5 tabular-nums"
                aria-live="polite"
                aria-label={
                  poles
                    ? `Showing ${n} boarding points, one per pole. Observed.`
                    : `Showing ${n} physical stop locations, clustered at 40 metres. Estimated.`
                }
              >
                {poles
                  ? `${n.toLocaleString()} boarding points · Observed`
                  : `${n.toLocaleString()} stop locations · Estimated`}
              </div>
            );
          })()}
          {/* North indicator — sits right above the native zoom/scale/attribution
              stack (all pinned bottom-right, measured 126px: 58px zoom group +
              10 + 18px scale bar + 10 + 20px attribution, each MapLibre-margined
              10px off the edge). `bottom-36` (144px) clears that with a clean
              ~18px gap; `right-[10px]` matches MapLibre's own control inset, so
              the arrow reads as the top of the same aligned column rather than a
              separately-placed overlay. No chip/background — the glyph floats
              over the map, theme-colored via the `ink` token (dark ink on the
              light basemap, cream ink on Dark Matter) instead of the old
              placeholder's baked-in black + mix-blend-mode hack.
              TODO(design): swap for the antique two-tone (ink/inkMuted) SVG,
              rotation-ready around a 50/50 pivot, once generated — this is
              still a placeholder silhouette pulled from north-arrow.svg. */}
          <div
            className="absolute bottom-36 right-[10px]"
            role="img"
            aria-label="North indicator — map is north-up"
            title="North-up"
          >
            <NorthArrowGlyph color={palette.ink} className="w-14 h-14" />
          </div>
          <button
            onClick={exportPNG}
            className="absolute top-2 right-2 font-mono text-xs bg-vellum/85 border border-border rounded px-1.5 py-1 text-inkMuted hover:text-ink"
            aria-label="Export map as PNG"
          >
            PNG ↓
          </button>
          {stopsAreSample && base.stops && (
            <div className="absolute top-2 left-12 font-mono text-xs text-inkMuted bg-vellum/85 border border-border rounded px-1.5 py-0.5">
              stops: sample n={stopsGeoJSON?.features.length ?? 0} of 6,880 boarding
              points — npm run fixtures
            </div>
          )}
        </>
      )}
    </div>
  );
});

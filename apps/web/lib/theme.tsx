"use client";

/**
 * Theme system (DESIGN.md §7 — the Night Chart). Light is the default; dark is
 * a deliberate, *persisted* instrument setting — never OS-forced (§7). One
 * source of truth (lib/tokens.ts), two outlets (§7.2):
 *
 *   1. DOM outlet   — CSS custom properties (`--color-*` as "R G B" channels) on
 *      :root (light) and [data-theme="dark"]. Tailwind reads these via the
 *      `rgb(var(--color-x) / <alpha-value>)` form, so every `bg-* / text-* / border-*`
 *      utility — including opacity modifiers like `bg-vellum/85` — retints for free.
 *   2. JS outlet    — `useThemePalette()` hands the active hex palette to things
 *      that can't read CSS vars: MapLibre paint, Recharts, raw SVG fills.
 *
 * The two outlets are generated from the SAME token objects, so they cannot drift.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { colors, colorsDark, matteTokens, type ColorToken } from "./tokens";

export type Theme = "light" | "dark";

const STORAGE_KEY = "propus-theme";

/** "#fcf9f3" → "252 249 243" (space-separated channels for `rgb(... / a)`). */
function hexToChannels(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

function varsFor(palette: Record<ColorToken, string>): string {
  return (Object.keys(palette) as ColorToken[])
    .map((k) => `--color-${k}:${hexToChannels(palette[k])};`)
    .join("");
}

/**
 * The `<style>` injected into <head> by the root layout. Defined here so the
 * palettes live in exactly one place (§7.2). `color-scheme` flips too, so native
 * scrollbars / form controls / the map's own chrome match.
 */
export const themeStyleCss = `:root{color-scheme:light;${varsFor(colors)}--matte-grain-opacity:${matteTokens.grain.opacity};}[data-theme="dark"]{color-scheme:dark;${varsFor(colorsDark)}--matte-grain-opacity:${matteTokens.grain.opacityDark};}`;

/**
 * Runs before first paint (see layout <head>) to set [data-theme] from the
 * persisted choice — prevents a flash of light before hydration. Kept tiny and
 * dependency-free; failures (private mode, disabled storage) fall back to light.
 */
export const noFlashScript = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");document.documentElement.dataset.theme=t==="dark"?"dark":"light";}catch(e){}})();`;

interface ThemeContextValue {
  theme: Theme;
  palette: Record<ColorToken, string>;
  /**
   * False during SSR and the first client render, true after the mount effect
   * has reconciled `theme` from the persisted choice. Client-only surfaces that
   * DON'T server-render DOM (e.g. the MapLibre canvas) can read the pre-set
   * [data-theme] attribute themselves before this flips, avoiding a one-frame
   * wrong-theme flash without risking a hydration mismatch.
   */
  hydrated: boolean;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  palette: colors,
  hydrated: false,
  setTheme: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start "light" on both server and first client render (matches the SSR
  // markup), then reconcile to the persisted value after mount. The pre-hydration
  // no-flash script has already painted the correct background, so there is no
  // visible flash — only the toggle glyph settles.
  const [theme, setThemeState] = useState<Theme>("light");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const attr = document.documentElement.dataset.theme;
    if (attr === "dark" || attr === "light") {
      setThemeState(attr);
    } else {
      try {
        if (localStorage.getItem(STORAGE_KEY) === "dark") setThemeState("dark");
      } catch {
        /* storage unavailable — stay light */
      }
    }
    setHydrated(true);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* storage unavailable — session-only theme */
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(theme === "dark" ? "light" : "dark"),
    [theme, setTheme]
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, palette: theme === "dark" ? colorsDark : colors, hydrated, setTheme, toggle }),
    [theme, hydrated, setTheme, toggle]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * The JS color outlet — the active hex palette plus the current theme name.
 * Use in MapLibre paint, Recharts, and raw SVG fills, which cannot read CSS
 * vars. Everything Tailwind-styled should use utilities and retint automatically.
 */
export function useThemePalette(): {
  theme: Theme;
  palette: Record<ColorToken, string>;
  hydrated: boolean;
} {
  const { theme, palette, hydrated } = useContext(ThemeContext);
  return { theme, palette, hydrated };
}

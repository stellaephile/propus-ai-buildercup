import type { Config } from "tailwindcss";
import { colors } from "./lib/tokens";

/**
 * Tailwind colors are generated from lib/tokens.ts — the single source of
 * truth. Never add a raw hex here or in a component.
 *
 * Each token resolves to `rgb(var(--color-<token>) / <alpha-value>)` rather than
 * a baked hex, so the whole palette retints when [data-theme] flips (the CSS-var
 * outlet in lib/theme.tsx supplies the channels) while opacity modifiers like
 * `bg-vellum/85` keep working. The hex values in tokens.ts are still the source;
 * they feed both the CSS vars and the JS palette (map/charts).
 */
const themeColors = Object.fromEntries(
  Object.keys(colors).map((token) => [token, `rgb(var(--color-${token}) / <alpha-value>)`])
) as Record<keyof typeof colors, string>;

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    // design-sync preview compositions (claude.ai/design) use the same utilities
    "../../.design-sync/previews/**/*.tsx",
  ],
  theme: {
    extend: {
      colors: themeColors,
      fontFamily: {
        // DESIGN.md §2 — Libre Caslon / Atkinson Hyperlegible / Martian Mono
        serif: ["var(--font-serif)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: {
        // DESIGN.md §3 — sm 2px (bubbles/inputs/stamps) · md 6px (cards/overlays)
        sm: "2px",
        md: "6px",
      },
      boxShadow: {
        // DESIGN.md §1.4 — THE one sanctioned shadow: ambient separation for
        // floating elements (tooltip, popover, map furniture, hover-lift).
        // 24px blur, 0 offset, ink at 4%; retints with the theme via the var.
        ambient: "0 0 24px 0 rgb(var(--color-ink) / 0.04)",
      },
    },
  },
  plugins: [],
};

export default config;

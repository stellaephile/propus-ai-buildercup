import type { Metadata, Viewport } from "next";
import { Libre_Caslon_Text, Atkinson_Hyperlegible, Martian_Mono } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";
import { InstrumentCursor } from "@/components/InstrumentCursor";
import { MatteGrain } from "@/components/MatteGrain";
import { ThemeProvider, themeStyleCss, noFlashScript } from "@/lib/theme";

// DESIGN.md §2 — the archival trio. Inter/Space Grotesk/Fraunces retired.
const serif = Libre_Caslon_Text({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});
const sans = Atkinson_Hyperlegible({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  variable: "--font-sans",
});
const mono = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

const TITLE = "Propus AI - Ask the city a question";
const DESCRIPTION =
  "Ask questions about Delhi's buses and metro in plain English. Real map data, and every number shows its source.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", siteName: "Propus AI" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

// vellum, the paper colour (lib/tokens.ts)
export const viewport: Viewport = { themeColor: "#fcf9f3" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* Theme color channels (light on :root, dark on [data-theme="dark"]) —
            generated from lib/tokens.ts so DOM and JS outlets can't drift (§7.2). */}
        <style dangerouslySetInnerHTML={{ __html: themeStyleCss }} />
        {/* Sets [data-theme] from the persisted choice before first paint — no
            flash of light for dark-mode users. */}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <ThemeProvider>
          <a
            href="#propus-query"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[10000] focus:rounded-sm focus:bg-celestial focus:px-3 focus:py-2 focus:text-sm focus:text-onCelestial"
          >
            Skip to the question box
          </a>
          {children}
          <MatteGrain />
          <InstrumentCursor />
        </ThemeProvider>
      </body>
    </html>
  );
}

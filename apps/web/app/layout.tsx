import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Propus AI - Ask the city a question",
  description:
    "Natural-language spatial analysis over Delhi transit and remote-sensing data. Real geometry, stated CRS, provenance on every number.",
};

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
          {children}
          <MatteGrain />
          <InstrumentCursor />
        </ThemeProvider>
      </body>
    </html>
  );
}

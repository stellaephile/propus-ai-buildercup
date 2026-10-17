"use client";

/**
 * SplashBackdrop — the art behind the startup wordmark.
 *
 * Pluggable ON PURPOSE. Drop a generated still or loop into apps/web/public/splash
 * and point NEXT_PUBLIC_SPLASH_BG at it; with nothing set, the built-in
 * procedural field renders and the app ships fine with zero assets. Nothing
 * here is ever displayed alongside real geometry — see splashTokens for the
 * boundary this component is required to hold (§3.1 / §12).
 *
 *   NEXT_PUBLIC_SPLASH_BG=/splash/observatory.webm   (or .mp4 / .jpg / .png / .webp)
 *   NEXT_PUBLIC_SPLASH_BG_POSTER=/splash/observatory.jpg   (video first frame)
 *
 * A video is decorative, so it never gates the card: the procedural field is
 * painted underneath and the asset crossfades in whenever it is decoded. Under
 * prefers-reduced-motion the loop is never fetched — the poster (or the field)
 * stands in.
 */

import { motion, useReducedMotion } from "framer-motion";
import { colors, colorsDark, motionTokens, splashTokens } from "@/lib/tokens";

const SRC = process.env.NEXT_PUBLIC_SPLASH_BG ?? "";
const POSTER = process.env.NEXT_PUBLIC_SPLASH_BG_POSTER ?? "";
const isVideo = /\.(mp4|webm|mov)$/i.test(SRC);

/**
 * The zero-asset default: a deep celestial field with an off-centre light well.
 * Abstract by construction — there is no geometry here to mistake for a map.
 */
function ProceduralField() {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background: `
          radial-gradient(120% 90% at 22% 18%, ${colors.primary}2e 0%, transparent 55%),
          radial-gradient(90% 70% at 82% 88%, ${colors.buffer}24 0%, transparent 60%),
          linear-gradient(160deg, ${colorsDark.vellum} 0%, ${colors.celestial} 100%)
        `,
      }}
    />
  );
}

export function SplashBackdrop() {
  const reduced = !!useReducedMotion();
  // a loop is motion the user opted out of; the poster carries the same frame
  const showVideo = isVideo && !reduced;
  const stillSrc = showVideo ? "" : isVideo ? POSTER : SRC;

  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      <ProceduralField />

      {showVideo && (
        <motion.video
          className="absolute inset-0 h-full w-full object-cover"
          style={{ filter: `saturate(${splashTokens.backdropSaturation})` }}
          src={SRC}
          poster={POSTER || undefined}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: motionTokens.dur.slow }}
        />
      )}

      {!showVideo && stillSrc && (
        <motion.img
          className="absolute inset-0 h-full w-full object-cover"
          style={{ filter: `saturate(${splashTokens.backdropSaturation})` }}
          src={stillSrc}
          alt=""
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduced ? 0 : motionTokens.dur.slow }}
        />
      )}

      {/* Scrim: keeps the wordmark and readout legible over whatever the asset
          turns out to be, and pushes the art back so it reads as ground rather
          than content. Kept deliberately light — the current backdrop measures
          dark enough that a heavy scrim would only hide it (see splashTokens). */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(75% 60% at 50% 45%, ${colors.celestial}${splashTokens.scrimCenter} 0%, ${colors.celestial}${splashTokens.scrimEdge} 100%)`,
        }}
      />
    </div>
  );
}

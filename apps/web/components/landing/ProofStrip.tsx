"use client";

/**
 * Proof strip (§6d): count-up numbers — real values, evidence-tagged.
 * Data honesty as branding.
 */

import { NETWORK_TOTALS } from "@/lib/data/wardMetrics";
import { CountUp } from "../CountUp";
import { EvidenceTag } from "../EvidenceTag";

// Distinct physical boarding points (stop_code), not raw GTFS rows. The feed
// lists 10,559 rows, but 3,679 of those are the same pole repeated once per
// serving route — "10,559 bus stops" would overstate the network by 53% on the
// one screen whose whole purpose is data honesty.
//
// Same problem existed for "bus routes": busRoutePatterns counts one row per
// (route number × direction × schedule variant), not distinct routes — see
// the comment on NETWORK_TOTALS.busRoutePatterns. No authoritative dedup key
// exists for routes the way stop_code does for stops, so rather than assert
// an unverifiable "real" route count, this is labelled for what it actually
// is: route×direction×variant patterns, not "bus routes".
const items = [
  { value: NETWORK_TOTALS.busBoardingPoints, label: "bus stops" },
  { value: NETWORK_TOTALS.wards, label: "MCD wards" },
  { value: NETWORK_TOTALS.busRoutePatterns, label: "bus route patterns" },
  { value: NETWORK_TOTALS.metroStops, label: "metro stations" },
  // metroLines: distinct color-coded lines in our own GTFS feed, not the raw
  // gtfs_metro.routes row count — see the sourced comment on
  // NETWORK_TOTALS.metroLines (also notes DMRC's current official count is
  // 12, and that our AQUA group is NMRC's line, not DMRC's).
  { value: NETWORK_TOTALS.metroLines, label: "metro lines" },
] as const;

export function ProofStrip() {
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
      {items.map((it) => (
        <div key={it.label}>
          <div className="font-mono text-2xl md:text-3xl tabular-nums text-ink">
            <CountUp value={String(it.value)} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-inkMuted">
            {it.label} <EvidenceTag evidence="Observed" />
          </div>
        </div>
      ))}
    </div>
  );
}

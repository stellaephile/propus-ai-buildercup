/**
 * Provenance tag (§3.3) — small monospace tag beside every number.
 * Evidence classes: Observed | Calculated | Estimated | Modelled.
 *
 * Four genuinely distinct hues, not two classes sharing one grey — chosen so
 * every pair stays perceptually separated (OKLab ΔE) in both themes, while
 * still reading as a confidence gradient, ground-truth to hypothetical:
 *   Observed   — primary (saturated blue): the strongest, most grounded signal
 *   Calculated — celestialMuted (desaturated blue): same family as Observed
 *                since it's arithmetic ON observed data, just one step removed
 *   Estimated  — madder (warm red-brown): pulls out of the blue family
 *                entirely to flag "approximated" — token is explicitly safe
 *                outside alarm contexts (lib/tokens.ts: "never an alarm")
 *   Modelled   — inkMuted (near-achromatic grey): the most synthetic/
 *                hypothetical class gets the least color of all
 * Fill + border style still repeat the distinction (redundant coding for
 * color-blind viewers and b/w printouts, §3.7 WCAG AA) but color now carries
 * it on its own. Never amber (§1.2 scalpel — alert/underserved data only) and
 * never a green/purple/pink hue (reserved for DMRC metro-line identity,
 * tokens.ts: "never use these for UI chrome"). All four hues are existing
 * tokens already AA-audited against vellum/sheet in both [data-theme] outlets.
 */

import type { Evidence } from "@propus/contract";
import { EVIDENCE_MEANING } from "@/lib/glossary";

const styles: Record<Evidence, string> = {
  Observed: "text-primary border-primary/50 bg-primary/10",
  Calculated: "text-celestialMuted border-celestialMuted/50 bg-celestialMuted/10",
  Estimated: "text-madder border-madder/50 border-dotted",
  Modelled: "text-inkMuted border-inkMuted/50 border-dashed italic",
};

export function EvidenceTag({ evidence }: { evidence: Evidence }) {
  return (
    <span
      className={`inline-block font-mono text-xs leading-none tracking-wide uppercase border rounded-sm px-1 py-0.5 align-middle ${styles[evidence]}`}
      title={`${evidence}: ${EVIDENCE_MEANING[evidence]}`}
    >
      {evidence}
      {/* title is mouse-only; this puts the meaning in the accessible name too */}
      <span className="sr-only">. {EVIDENCE_MEANING[evidence]}</span>
    </span>
  );
}

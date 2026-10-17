"use client";

/**
 * "How to read this" — a plain-language orientation for first-time readers.
 * Native <dialog>: showModal() gives the focus trap, Esc to close, inert
 * background and focus return to the trigger without custom code.
 */

import { useRef } from "react";
import type { Evidence } from "@propus/contract";
import { EVIDENCE_MEANING, GLOSSARY, LIMITS, SOURCES } from "@/lib/glossary";
import { EvidenceTag } from "./EvidenceTag";

const EVIDENCE_ORDER: Evidence[] = ["Observed", "Calculated", "Estimated", "Modelled"];

export function HelpDialog({
  label = "How to read this",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className={`min-h-[32px] rounded-sm px-2 text-xs underline underline-offset-2 ${className}`}
      >
        {label}
      </button>
      <dialog
        ref={ref}
        aria-labelledby="help-title"
        // a click on the backdrop lands on the <dialog> element itself
        onClick={(e) => e.target === ref.current && ref.current?.close()}
        className="m-auto w-[min(92vw,40rem)] max-h-[85vh] overflow-y-auto rounded-lg bg-sheet p-0 text-ink backdrop:bg-ink/40"
      >
        <div className="px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <h2 id="help-title" className="font-serif text-2xl">
              How to read Propus
            </h2>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="min-h-[32px] shrink-0 rounded-sm border border-border px-3 text-sm hover:bg-vellumShade"
            >
              Close
            </button>
          </div>

          <p className="mt-3 text-sm">
            Propus answers questions about Delhi&apos;s bus and metro network, asked in plain
            English. Each answer is a table, a chart or a layer on the map, with the data source
            and method behind it.
          </p>

          <h3 className="mt-5 text-sm font-medium">How to use it</h3>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm">
            <li>Click an example question, or type your own.</li>
            <li>Watch the steps it takes. Each one is shown as it happens.</li>
            <li>Read the result, then open &quot;Methodology&quot; on a card to see the formula and sources.</li>
          </ol>

          <h3 className="mt-5 text-sm font-medium">How far to trust a number</h3>
          <p className="mt-1 text-sm text-inkMuted">
            Every figure carries a small tag that says where it comes from.
          </p>
          <dl className="mt-2 space-y-2 text-sm">
            {EVIDENCE_ORDER.map((e) => (
              <div key={e} className="flex items-baseline gap-3">
                <dt className="w-24 shrink-0">
                  <EvidenceTag evidence={e} />
                </dt>
                <dd>{EVIDENCE_MEANING[e]}</dd>
              </div>
            ))}
          </dl>

          <h3 className="mt-5 text-sm font-medium">Words you will see</h3>
          <dl className="mt-2 space-y-2 text-sm">
            {GLOSSARY.map((g) => (
              <div key={g.term}>
                <dt className="font-medium">{g.term}</dt>
                <dd className="text-inkMuted">{g.meaning}</dd>
              </div>
            ))}
          </dl>

          <h3 className="mt-5 text-sm font-medium">What to keep in mind</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
            {LIMITS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>

          <h3 className="mt-5 text-sm font-medium">Privacy</h3>
          <p className="mt-1.5 text-sm text-inkMuted">
            Each question you type is logged: the text, the tools used and how long the answer
            took. No account, IP address or session id is stored. Please do not type personal
            information.
          </p>

          <h3 className="mt-5 text-sm font-medium">Data sources</h3>
          <p className="mt-1.5 text-sm text-inkMuted">{SOURCES}</p>
        </div>
      </dialog>
    </>
  );
}

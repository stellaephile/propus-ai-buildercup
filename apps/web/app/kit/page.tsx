"use client";

/**
 * /kit — the design-system route (TASKS.md A5). Every primitive, restyled to
 * tokens, AA-contrast, with amber shown ONLY on the underserved example.
 */

import Link from "next/link";
import { colors } from "@/lib/tokens";
import { EvidenceTag } from "@/components/EvidenceTag";
import { ReasoningChips } from "@/components/ReasoningChips";
import { ResultSkeleton } from "@/components/Skeletons";
import { StatCards } from "@/components/results/StatCards";
import { DataTable } from "@/components/results/DataTable";
import { Comparison } from "@/components/results/Comparison";
import { ScatterChartCard } from "@/components/results/Charts";
import { PivotTable } from "@/components/results/PivotTable";

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className="w-8 h-8 rounded-md border border-borderStrong"
        style={{ background: value }}
        aria-label={`${name} ${value}`}
      />
      <div>
        <div className="text-ink">{name}</div>
        <div className="font-mono text-inkFaint">{value}</div>
      </div>
    </div>
  );
}

export default function KitPage() {
  return (
    <main className="min-h-screen bg-vellum px-8 py-10 max-w-4xl mx-auto space-y-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-3xl text-ink">Propus AI kit</h1>
        <Link href="/" className="font-mono text-xs text-celestialMuted hover:text-celestial">
          ← observatory
        </Link>
      </header>

      <section aria-labelledby="kit-colors">
        <h2 id="kit-colors" className="text-sm font-medium text-inkMuted mb-3">
          Tokens — lib/tokens.ts is the single source of truth
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(colors).map(([k, v]) => (
            <Swatch key={k} name={k} value={v} />
          ))}
        </div>
        <p className="mt-3 text-xs text-inkMuted max-w-prose">
          <span className="font-mono text-alert">alert</span> is a
          scalpel: underserved/alert data points only — never a panel, sidebar, or background.
        </p>
      </section>

      <section aria-labelledby="kit-type">
        <h2 id="kit-type" className="text-sm font-medium text-inkMuted mb-3">Type</h2>
        {/* DESIGN.md §2 — the archival trio (Inter/Space Grotesk/Fraunces are
            retired; this section named them long after the swap). */}
        <p className="font-serif text-2xl text-ink">Serif — Libre Caslon Text, headlines</p>
        <p className="font-sans text-base text-ink">Sans — Atkinson Hyperlegible, UI and prose</p>
        <p className="font-mono text-base text-ink tabular-nums">
          Mono — Martian Mono, 10,559 · 28.66788°N · numbers always
        </p>
      </section>

      <section aria-labelledby="kit-evidence">
        <h2 id="kit-evidence" className="text-sm font-medium text-inkMuted mb-3">
          Provenance tags
        </h2>
        <div className="flex gap-2">
          <EvidenceTag evidence="Observed" />
          <EvidenceTag evidence="Calculated" />
          <EvidenceTag evidence="Estimated" />
          <EvidenceTag evidence="Modelled" />
        </div>
      </section>

      <section aria-labelledby="kit-chips">
        <h2 id="kit-chips" className="text-sm font-medium text-inkMuted mb-3">
          Reasoning chips — pending → active → done; amber = failure grammar
        </h2>
        <ReasoningChips
          chips={[
            { step: "Reading derived.ward_metrics", state: "done" },
            { step: "Buffering 500 m in EPSG:32643", state: "active" },
            { step: "Zonal stats (WorldPop)", state: "failed" },
          ]}
          startedAt={null}
          doneMs={412}
          failedMessage="WorldPop raster unavailable — the buffer still stands; population omitted."
          onRetry={() => {}}
        />
      </section>

      <section aria-labelledby="kit-bubbles">
        <h2 id="kit-bubbles" className="text-sm font-medium text-inkMuted mb-3">
          Chat bubbles — the asymmetry is deliberate
        </h2>
        {/* This used to show a matching "agent reply" bubble in a bordered
            sheet box — a pattern the app doesn't actually have. §4 defines
            exactly one bubble (the user's); the agent never replies in a
            bubble, only in a result card (see every section below). Markup
            here is copied verbatim from ChatPane.tsx so this stays truthful
            as that component changes. */}
        <div className="max-w-md">
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-sm bg-slate text-ink px-3.5 py-2 text-sm">
              Which wards have the worst transit access?
            </div>
          </div>
          <p className="mt-2 text-xs text-inkFaint">
            The agent never replies in a bubble — only in a result card, like the ones below.
          </p>
        </div>
      </section>

      <section aria-labelledby="kit-stats">
        <h2 id="kit-stats" className="text-sm font-medium text-inkMuted mb-3">
          Stat cards — amber only on the underserved figure
        </h2>
        <StatCards
          kind="stat_cards"
          cards={[
            { label: "Wards with zero bus stops", value: "23", unit: "of 290", evidence: "Calculated", alert: true },
            { label: "Bus stops network-wide", value: "10559", evidence: "Observed" },
            { label: "Peak freq, Kashmere Gate", value: "35.46", unit: "buses/hr", evidence: "Calculated" },
          ]}
        />
      </section>

      <section aria-labelledby="kit-table">
        <h2 id="kit-table" className="text-sm font-medium text-inkMuted mb-3">
          Data table — sortable, CSV export, click a row for attributes
        </h2>
        <DataTable
          kind="data_table"
          columns={["Ward", "Stops", "Score"]}
          rows={[
            ["SANGAM VIHAR", 0, "0.0000"],
            ["JAITPUR", 1, "0.0046"],
            ["KASHMERE GATE", 110, "0.6842"],
          ]}
          alertRows={[0, 1]}
          evidence="Calculated"
        />
      </section>

      <section aria-labelledby="kit-comparison">
        <h2 id="kit-comparison" className="text-sm font-medium text-inkMuted mb-3">Comparison</h2>
        <Comparison
          kind="comparison"
          a={{ id: "KASHMERE GATE", name: "Kashmere Gate" }}
          b={{ id: "SANGAM VIHAR", name: "Sangam Vihar" }}
          metrics={[
            { label: "Bus stops", a: "110", b: "0", evidence: "Calculated" },
            { label: "Transit score", a: "0.6842", b: "0.0000", evidence: "Calculated" },
          ]}
          disparityLabel="110 bus stops and 35.5 buses/hr against zero service."
        />
      </section>

      <section aria-labelledby="kit-scatter">
        <h2 id="kit-scatter" className="text-sm font-medium text-inkMuted mb-3">
          Scatter — amber only on underserved points (values from derived.ward_metrics)
        </h2>
        <ScatterChartCard
          kind="scatter_chart"
          x="pop_total"
          y="bus_stop_count"
          xLabel="Population (WorldPop 2020)"
          yLabel="Bus stops"
          points={[
            { label: "SAID UL AJAIB", x: 8728, y: 0, alert: true },
            { label: "PREM NAGAR", x: 14687, y: 0, alert: true },
            { label: "TIGRI", x: 40380, y: 0, alert: true },
            { label: "SANGAM VIHAR", x: 17413, y: 0, alert: true },
            { label: "KASHMERE GATE", x: 113812, y: 110 },
            { label: "CHHAWLA", x: 77868, y: 202 },
            { label: "BIJWASAN", x: 134342, y: 182 },
            { label: "BAWANA", x: 214222, y: 216 },
          ]}
          evidence="Estimated"
          title="Population vs bus stops"
        />
      </section>

      <section aria-labelledby="kit-pivot">
        <h2 id="kit-pivot" className="text-sm font-medium text-inkMuted mb-3">
          Pivot table — grouped header, em dash for genuine nulls (never a fabricated zero)
        </h2>
        <PivotTable
          kind="pivot_table"
          rowDim="Ward"
          colDims={[
            "Stops / Bus",
            "Stops / Metro",
            "Service / Peak freq/hr",
            "Service / Transit score",
            "Equity / Stops per 10k",
          ]}
          rows={[
            { label: "KASHMERE GATE", values: [110, 3, 35.4576, 0.6842, 9.6651] },
            { label: "BAWANA", values: [216, 0, 14.8333, 0.4714, 10.083] },
            { label: "SAID UL AJAIB", values: [0, 0, null, 0.0, 0.0] },
          ]}
          evidence="Calculated"
          title="Ward service pivot"
        />
      </section>

      <section aria-labelledby="kit-skeletons">
        <h2 id="kit-skeletons" className="text-sm font-medium text-inkMuted mb-3">
          Shaped skeletons — the answer&apos;s silhouette in &lt; 300 ms
        </h2>
        <div className="grid md:grid-cols-2 gap-3">
          <ResultSkeleton kind="data_table" />
          <ResultSkeleton kind="stat_cards" />
        </div>
      </section>
    </main>
  );
}

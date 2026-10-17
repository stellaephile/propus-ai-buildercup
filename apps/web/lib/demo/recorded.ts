/**
 * Recorded answers for the sustainability questions. Each fixture is the real
 * /query/stream output captured by scripts/record_demo.py: nothing here is
 * typed by hand. They play in demo mode and as the fallback when the live
 * agent is down, and every one says it is recorded.
 */

import type { Methodology, PropusResult } from "@propus/contract";
import type { BuiltQuery, QueryIntent } from "./queries";
import coverageGap from "./recorded/coverage_gap.json";
import heat from "./recorded/heat.json";
import refusal from "./recorded/refusal.json";

interface Fixture {
  question: string;
  recordedAt: string;
  steps: string[];
  results: { payload: unknown; methodology?: unknown }[];
}

export type RecordedIntent = Extract<QueryIntent, "heat" | "coverage_gap" | "refusal">;

const FIXTURES: Record<RecordedIntent, Fixture> = {
  heat: heat as Fixture,
  coverage_gap: coverageGap as Fixture,
  refusal: refusal as Fixture,
};

export function buildRecorded(intent: RecordedIntent): BuiltQuery {
  const f = FIXTURES[intent];
  return {
    intent,
    steps: f.steps,
    results: f.results.map((r) => ({
      payload: r.payload as PropusResult,
      methodology: (r.methodology ?? undefined) as Methodology | undefined,
    })),
    notices: [
      `Recorded answer, captured ${f.recordedAt} from the live agent on real data. Run it with the live agent for current figures.`,
    ],
  };
}

/**
 * Demo-mode SSE replay: emits the typed PropusEvent sequence (§6a) with
 * realistic pacing so the reveal choreography (§6b) runs identically to live
 * mode. A model outage cannot kill this path (CLAUDE.md §5.2).
 */

import type { PropusEvent } from "@propus/contract";
import type { BuiltQuery } from "./queries";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* replay(
  built: BuiltQuery,
  opts: { reducedMotion?: boolean } = {}
): AsyncGenerator<PropusEvent> {
  const t0 = performance.now();
  const pace = opts.reducedMotion ? 0 : 1;

  yield { event: "plan", kinds: built.results.map((r) => r.payload.kind) };
  await sleep(120 * pace);

  for (const step of built.steps) {
    yield { event: "reasoning_step", step };
    await sleep((260 + Math.random() * 240) * pace);
  }

  for (let i = 0; i < built.results.length; i++) {
    yield {
      event: "result",
      index: i,
      payload: built.results[i].payload,
      methodology: built.results[i].methodology,
    };
    await sleep(150 * pace);
  }

  yield {
    event: "done",
    query_id: `demo-${Date.now().toString(36)}`,
    ms: Math.round(performance.now() - t0),
    mode: "demo",
  };
}

/**
 * Live-mode client: parses the same typed events from the FastAPI SSE
 * endpoint. Never streams raw text chunks (§6a).
 */
export async function* liveStream(
  apiUrl: string,
  query: string,
  signal?: AbortSignal
): AsyncGenerator<PropusEvent> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    // QueryRequest (apps/api/main.py) — the field is `message`
    body: JSON.stringify({ message: query }),
    signal,
  });
  if (!res.ok || !res.body) {
    yield {
      event: "error",
      message: `Agent unreachable (HTTP ${res.status}). Demo mode still works.`,
      recoverable: true,
    };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        yield JSON.parse(dataLine.slice(5).trim()) as PropusEvent;
      } catch {
        // malformed frame — vellum as recoverable error, never render raw text
        yield { event: "error", message: "Malformed event from agent.", recoverable: true };
      }
    }
  }
}

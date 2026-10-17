# AGENT_AUDIT.md — Agent framework, prompt engineering & guardrails

Code audit of `apps/api/agent.py`, `apps/api/main.py`, `db/roles.sql`.
Date: 2026-07-07. Findings ordered by priority within each section.

---

## 0. Framework verdict

**Stack: Google ADK + LiteLLM** (Gemini natively; Groq open-weight models via `groq/...`
routes). **Not LangChain — and it shouldn't be.** The two things LangChain is usually
reached for are already solved leaner here: plain Python functions as tools with
docstring-derived schemas (orchestration), and the typed `PropusResult` contract
(composition). Adding LangChain = dependency + abstraction tax, no new capability. Only
revisit if multi-step LangGraph-style graphs are ever wanted — which the deterministic
PostGIS design deliberately avoids.

---

## 1. Prompt engineering — what is already good practice

- **Tools do the math, the model does the routing.** No spatial computation is ever asked
  of the LLM — everything routes to parametrized PostGIS `fn_*` functions. The single most
  important practice for a numbers-credibility product.
- **Explicit routing table** in the prompt (query pattern → tool name) — the correct way to
  get reliable tool selection from mid-tier models.
- **Capability-matched prompt tiers**: slim prompt + 6-tool subset for Groq (full 12-tool
  schema exceeds the 8k request cap), full prompt for Gemini.
- **Context-budget discipline**: the geometry side-channel (`agent.py` `_GEOM_STASH`) keeps
  polygons out of the conversation entirely.
- **Grounding + negative knowledge**: ID formats, data caveats (NDVI NULL → say so), and
  known-absent entities (Dwarka/Seemapuri) stated up front.
- **Tool docstrings written as the schema they are** — Args/Returns/caveats.

## 2. Prompt engineering — gaps (priority order)

### P1 — Anti-fabrication guardrail missing from the advanced-tier prompt
`SIMPLE_SYSTEM_PROMPT` says "Never invent numbers — report only what tools return";
`SYSTEM_PROMPT` (the *more open-ended* Gemini tier) does not. Given hard rule §3.1, add it
to both, plus: "if a tool returns an error, report it plainly; never estimate a substitute
value."

### P2 — Volatile facts hardcoded in the prompt
"10,559 stops, 2,403 routes, 290 wards, 23 zero-stop wards, verified 2026-07-06" go stale
on any data refresh and break entirely under multi-city. Fix: dynamic prompt assembly —
query counts at startup, template them in. Dovetails with the city-manifest templating
(`ATLAS.md` §1): one refactor solves both.

### P3 — No temperature control
`Agent(...)` uses provider defaults (Gemini ≈ 1.0). Tool-routing agents want 0–0.2 —
cheapest reliability win available, especially for the Groq tool-callers already annotated
as flaky in `SIMPLE_MODEL_CHAIN`.

### P4 — No routing eval harness
Prompt edits are vibes-verified. A ~30-line script running the 5 headline queries + a few
paraphrases, asserting **which tool got called** (not the prose), catches routing
regressions. Within the smoke-test budget CLAUDE.md allows. (See `GOLDEN_QUERIES.md`.)

### P5 — `classify_complexity` is substring matching
Markers like `"if "`, `"why "`, `"plan "` misfire on ordinary phrasing. Failure mode is
benign (wrong tier = cost/latency, not wrong answers) — acceptable for the prototype;
noted so nobody mistakes it for semantic classification.

### P6 — Simple-tier fallback chain appears unreachable
`SIMPLE_MODEL_CHAIN[1:]` (qwen3, llama) is never selected: `pick_model` only returns index
0 and `run_with_fallback` iterates the Gemini chain only. If Groq fallback isn't handled
elsewhere, a gpt-oss outage silently drops simple-tier queries onto Gemini, contradicting
the chain's own comment.

---

## 3. Guardrails inventory (layered, strongest first)

Design philosophy (CLAUDE.md §5): the database and code enforce safety deterministically;
the prompt only advises.

### Layer 1 — Database (`db/roles.sql`) — the hard boundary
- Dedicated read-only role `propus_agent_ro` — LOGIN only, no
  superuser/createdb/createrole.
- Explicit `GRANT SELECT` allowlist (17 tables); new tables invisible by default.
- `statement_timeout = 5s` at role level.
- `EXECUTE` on only the 4 `fn_*` functions.
- **Net: a fully prompt-injected agent can at worst read allowed tables slowly for 5s.**

### Layer 2 — Query shape (`agent.py`)
- The agent never writes SQL: fixed strings with bound parameters; user input never
  string-interpolates. (The one f-string is the schema name, constrained to
  `gtfs_bus`/`gtfs_metro` literals by a `startswith` check.)
- Hard LIMITs on every tool query.

### Layer 3 — Model runtime (`agent.py`)
- 25s hard timeout per query (`asyncio.wait_for`).
- 429/quota detection → exponential backoff with jitter (2s→30s) → after 2 failures,
  demote down the 5-model Gemini chain; auto-reset to primary on recovery.
- Tiered routing: no single provider outage takes everything down.

### Layer 4 — Context & payload
- Geometry side-channel: LLM never sees polygons; bounded LRU stash (32 refs). Also an
  *integrity* guardrail — the map can only render real, stashed geometry; the model has no
  channel to fabricate coordinates onto the map.
- Slim 6-tool set for the 8k-context tier.
- Server-side simplification + 5-decimal rounding (`fn_ward_choropleth`) for the <1 MB
  payload budget.

### Layer 5 — API (`main.py`)
- Typed `ErrorEvent`s with `recoverable` flag; formatter failures degrade into an alert
  stat-card, the rest of the response survives.
- Demo mode (`/query/demo`, cached results): a total model outage cannot kill the pitch.

### Layer 6 — Prompt (advisory only, by design)
- "Never invent numbers" (simple tier only — see P1).
- Negative knowledge; mandatory NULL-RS disclosure; routing table.

---

## 4. Guardrail gaps

### G1 — The read-only guarantee is soft (fix before pitch)
If `AGENT_DATABASE_URL` is unset, the agent silently falls back to the owner
`DATABASE_URL` with only a log warning (`agent.py` `get_engine`). In a deployed
environment that's the entire DB layer quietly disabled. Fix: hard-fail the fallback when
running deployed (e.g. refuse if `RENDER` env var present). ~5 lines.

### G2 — Raw exception strings reach the client (fix before pitch)
`main.py` yields `str(exc)` in the `ErrorEvent` — violates the §6c failure grammar
("never a raw exception string") and can leak connection details. Map to plain-language
messages. ~5 lines.

### G3 — CORS wildcard
`allow_origins=["*"]`, already flagged in code as "restrict in production."

### G4 — Advanced tier has the fewest behavioral constraints
Same as P1 — the most capable model lacks the anti-fabrication line.

### G5 — No auth or API rate-limiting
Documented non-goal for the pitch build, but the public Render URL is an open proxy to
Gemini/Groq quota, and the keep-warm ping makes it discoverable. Cheap mitigation when it
matters: static header token checked in middleware.

---

## 5. Verdict

The shape is right: deterministic layers (1–2) do the real enforcement; probabilistic
layers (6) only steer. Several practices are above-average (side-channel, tiering, routing
table). Fix G1 + G2 before the pitch (both ~5-line changes); P1–P3 are small and high-ROI;
P2 is work multi-city requires anyway.

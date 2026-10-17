# Propus — Architecture & Handoff Notes

A brutally honest snapshot for whoever (human or Claude session) picks this repo up next.
Goal: know what's real, what's legacy, what's verified, and what to check before building on
top of it.

**Last verified 2026-07-07 against the `V2.0` branch.** This supersedes the earlier snapshot
that described the V1 Streamlit / Cloud SQL / single-model stack — that architecture is now
**legacy** (see §9). If any older doc in the repo root disagrees with this file, trust this
file and the code.

---

## 1. What this actually is (V2.0)

Propus is a natural-language agent over Delhi transit + remote-sensing data, presented as a
pitch-ready prototype: a **Next.js** map/chat frontend talking over **SSE** to a **FastAPI +
ADK (Gemini/Groq) agent**, which calls **parametrized PostGIS functions** against a
**Supabase** Postgres/PostGIS database. The database holds:

- Delhi bus GTFS (DTC): 10,559 stops, 2,403 routes
- Delhi metro GTFS (DMRC): 262 stops, 36 routes
- 290 Delhi ward polygons with computed transit metrics (`derived.ward_metrics`)
- WorldPop 2020 population + Sentinel-2 NDVI/NDBI, zonal-stats'd per ward (`urban_stress_index`)

The central design rule: **the frontend never renders from raw SQL or raw agent text.** The
agent decides the analysis and returns a **typed result** (the `PropusResult` discriminated
union); the frontend picks the component and the map draws whatever GeoJSON + style spec the
result carries. The map is deliberately "dumb."

```
Next.js (Vercel) ──SSE──▶ FastAPI agent (Render) ──▶ Supabase Postgres/PostGIS
      │                          │                          │
  MapLibre + deck.gl        typed PropusResult /       parametrized PostGIS
  render map layers         PropusEvent contract       functions (db/functions.sql)
      │                          │                     via read-only role
      └── demo mode: replays recorded typed streams, no backend needed ──┘
```

---

## 2. The monorepo layout (this is deliberate — do not split it)

| Path | What | Notes |
|---|---|---|
| `apps/web/` | Next.js (App Router) + TypeScript frontend | deploys to Vercel via root-directory setting |
| `apps/api/` | FastAPI + ADK agent | deploys to Render; **canonical backend** |
| `packages/contract/` | `PropusResult` + `PropusEvent` TS types | single source of truth, mirrored into Pydantic |
| `db/` | `schema.sql`, `functions.sql`, `roles.sql` | the deterministic geo layer + DDL |
| `pipeline/` | GTFS ingest, ward-metric compute, RS zonal stats | unchanged from V1 |
| `docs/` | `DESIGN.md`, `TASKS.md`, `BUGS.md`, `CARES.md`, etc. | working docs |
| `apps/web/public/fixtures/` | `wards.geojson`, `stops.json` | real geometry shipped to the client (~768 KB) |

**The contract is the spine.** `packages/contract/src/index.ts` defines the discriminated
union (`stat_cards | data_table | bar_chart | line_chart | comparison | map_layer`) and the SSE
event union (`plan | reasoning_step | result | done | error`). `apps/api/schemas.py` mirrors
these as Pydantic models. If you change one, change both — they are manually kept in sync.

### 2a. Frontend data flow (`apps/web`)

- `app/page.tsx` — the single page; owns the shared MapLibre instance (landing → app is one
  continuous "zero-cut" shot, the map never remounts).
- `lib/useQueryRunner.ts` — the query state machine. Consumes the typed event stream (demo
  replay **or** live SSE), drives chips → skeletons → staggered result cards → the map
  choreography. Also owns the **turn history** (archived prior turns; see §8 B3).
- `lib/demo/queries.ts` + `lib/demo/stream.ts` — **demo mode**: builds and replays the typed
  event sequence for the 5 headline queries entirely client-side from real recorded data. No
  backend, no LLM. A model outage cannot kill the demo (CLAUDE.md §5.2).
- `lib/map/useMapConductor.ts` — the "conductor": bridges Framer's DOM timeline and MapLibre's
  camera. Fires `flyTo`/`fitBounds`, resolves on `moveend`, then gates the layer fade.
- `components/map/MapView.tsx` — the dumb map + GIS furniture (scale bar, coord readout, north
  indicator, layer manager, attribute inspection, PNG/GeoJSON/CSV export).
- Mode is chosen at runtime: `NEXT_PUBLIC_MODE=live` **and** `NEXT_PUBLIC_API_URL` set → live
  SSE; otherwise demo. There is no `.env.local` committed; without one the app runs in demo
  mode (safe default for the pitch).

### 2b. Backend (`apps/api`)

- `main.py` — FastAPI app. Endpoints:
  - `POST /query/stream` — SSE stream of typed `PropusEvent`s for a live query.
  - `GET /query/demo` — a hardcoded `data_table` result (contract round-trip proof, no DB/LLM).
  - `GET /health` — reports whether `DATABASE_URL` is configured.
  - `GZipMiddleware` on; CORS still wide open (`allow_origins=["*"]`, "restrict in production").
- `agent.py` — the ADK agent and its tools. Two things worth knowing:
  1. **Tiered model routing.** `classify_complexity(query)` returns `"simple"` or `"advanced"`.
     Simple queries run on an **open-source model via Groq** (`groq/openai/gpt-oss-120b`);
     genuinely advanced queries (scenario / multi-step) run on the **Gemini** chain
     (`MODEL_CHAIN`). `pick_model(tier)` resolves the model and falls back to Gemini if
     `GROQ_API_KEY` is unset. One cached runner per tier (`_runners` in `main.py`).
  2. **Geometry side-channel.** The LLM never sees polygons. Embedding ward/buffer GeoJSON
     would 413 Groq's free tier and burn Gemini tokens for nothing, so only the **formatter**
     attaches geometry out-of-band; the model reasons over scalar tool outputs only. A **slim
     tool set** is used for the simple tier (Groq's free tier caps a single request's payload).
- `formatters.py` — converts each agent tool response into typed `PropusResult`s + a
  `METHODOLOGY` entry. This is where "agent output → contract" happens.
- Escalation & result-preservation: if a model call fails **after** typed results were already
  computed from real tool calls, the results are shipped with a warning rather than discarded;
  a simple-tier failure with no results yet escalates to Gemini once (see `_stream_query`).

### 2c. The deterministic geo layer (`db/`) — the credibility spine for the GIS audience

The agent **never free-writes spatial SQL.** It calls parametrized PostGIS functions:

- `db/schema.sql` — **now exists** (the single biggest reproducibility gap in V1 is closed).
  Schemas: `gtfs_bus`, `gtfs_metro`, `derived`, `embeddings`, and `public.wards`. Key derived
  tables: `derived.ward_metrics`, `route_geometries`, `route_stops`, `stop_hourly_frequency`;
  `embeddings.stop_embeddings` (pgvector, optional).
- `db/functions.sql` — `fn_worst_wards(metric, n)`, `fn_ward_density_rank(n)`,
  `fn_ward_choropleth()`, `fn_catchment(lon, lat, radius_m)`, plus a `_simplify_round()` helper
  that `ST_SimplifyPreserveTopology`'s and rounds coordinates to 5 decimals so the choropleth
  payload stays under the ~1 MB budget. Faster, injection-proof, and exactly the rigor the GIS
  audience expects.
- `db/roles.sql` — a read-only, table-allowlisted role `propus_agent_ro` with
  `statement_timeout = '5s'` and no SUPERUSER/CREATEDB/CREATEROLE. The agent connects as this
  role, never as the Supabase owner. Idempotent; run once as the owner.

**Supabase free-tier discipline:** only derived tables + geometry + a stop sample are loaded —
**never** raw `stop_times` (~3.7M rows). Headway/frequency/catchment are precomputed upstream
in `pipeline/`.

---

## 3. What's verified vs assumed (as of this session)

- **Frontend, demo mode:** verified live this session in a browser. The 5 headline queries
  run end-to-end; the choropleth/buffer layers render; camera framing, turn archiving, and
  scenario pick-mode all work (see §8). This is the safe pitch path.
- **Backend live path (`/query/stream`), Supabase, Groq/Gemini routing, PostGIS functions:**
  implemented and committed, but **not exercised end-to-end this session.** Standing them up
  needs `DATABASE_URL` (Supabase pooler), `GROQ_API_KEY`, and `GOOGLE_API_KEY`. Treat as
  "implemented, live path unverified" until someone runs a real query against it.
- **RS pipeline** (`ndvi_mean`/`ndbi_mean`/`urban_stress_index`) and **pgvector embeddings:**
  the agent assumes these are populated in prod; unverified this session. Trigram fallback is
  the safe assumption for semantic search.
- **Automated tests:** still none. Everything "verified" was verified by running it once and
  reading the output. A minimal smoke test (spin up FastAPI, hit `/health` + `/query/demo`)
  remains the cheapest first win.

---

## 4. Deployment reality (V2.0)

Target per CLAUDE.md §4: **Vercel Hobby** for `apps/web`, **Render free web service** for
`apps/api`, both pointed at their subdirectory via root-directory settings — one repo,
independent deploys. Supabase free tier for the DB (PostGIS + pgvector).

- Render free tier sleeps after idle; add an external keep-warm ping (UptimeRobot / GitHub
  Actions cron, ~10 min) and hit the URL before walking into the demo.
- The old GCP Cloud Run path (`cloud-run/`, `deploy.sh`, `cloudbuild.yaml`,
  `docker-compose.yml`) belongs to the V1 stack (§9). Don't wire the V2 apps to it.

---

## 5. Env & secrets

- `.env` at repo root is loaded by `apps/api/main.py` (`DATABASE_URL`, `GROQ_API_KEY`,
  `GOOGLE_API_KEY`). Not committed.
- `apps/web/.env.example` documents `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_MODE`; note it now
  ships `live` as the example value, so a fresh copy will hit the backend by default — for
  pure demo, leave `NEXT_PUBLIC_MODE` unset/`demo`.
- No service-account key files live in the repo. Key JSON patterns are `.gitignore`d
  (`*service-account*.json`, `*-key.json`, `credentials*.json`). Don't bake keys into any image.

---

## 6. Legacy still on disk (V1 — superseded, not deleted)

These directories are the **retired V1 stack**. They still work in isolation but are not part
of the V2.0 data flow. Don't build on them; don't copy fixes into them.

- `agent/`, `api/`, `mcp_server/`, `frontend/` — the old ADK-agent / FastAPI / MCP / Streamlit
  copies. `apps/api/` is the canonical backend now; `apps/web/` replaced the Streamlit skin.
- `cloud-run/` — the old GCP Cloud Run deploy (Streamlit + FastAPI), including a duplicated
  `cloud-run/fastapi/{agent,api,mcp_server}/` tree. The V1 root-vs-cloud-run duplication was a
  real bug factory; the V2 rule (CLAUDE.md §10) is a single canonical copy under `apps/`.
- Assorted root-level deploy docs (`DEPLOYMENT*.md`, `GCP_DEPLOYMENT.md`, `SETUP_SUMMARY.md`,
  etc.) — historical scratch notes; several contradict each other. This file + `README.md` are
  canonical.

Recommendation for a future cleanup pass: delete the V1 trees once you've confirmed nothing in
`pipeline/` still imports from them.

---

## 7. Known rough edges worth fixing before scaling

- **CORS is wide open** (`allow_origins=["*"]`) with a comment nobody has acted on.
- **No rate limiting / auth** on the FastAPI layer — fine for a demo, not for scale.
- **`ward_fallback_000`** — one of the 290 wards had a null `ward_id` in the source shapefile
  and got a synthetic fallback ID. Real data, no human-readable name; trace it back to the
  source shapefile to assign its MCD ward name.
- **Contract drift risk** — `packages/contract` and `apps/api/schemas.py` are hand-synced.
  A codegen step (TS types → Pydantic, or a shared JSON schema) would remove the footgun.
- **`pipeline/embed.py`** still has a hardcoded absolute `.env` path from V1 — regenerating
  embeddings off the original author's machine silently no-ops the env load.

---

## 8. Bug log resolved this session (docs/BUGS.md B1–B5)

All five functional bugs from `docs/BUGS.md §1` were fixed on `V2.0`; B1/B2/B3/B5 were
re-verified live in the browser (demo mode).

- **B1 — result layers never rendered (CRITICAL).** In `MapView.tsx` the fill/line/ring
  `<Layer>`s were wrapped in a bare fragment inside `<Source>`, so react-map-gl never injected
  the source id → `missing required property "source"` flooded the console and no
  choropleth/buffer ever drew. **Fix:** explicit `source={`res-${l.id}`}` on each `<Layer>`.
  Verified: 0 source errors; amber underserved-ward polygons now render.
- **B2 — scenario misrouted to the catchment fixture.** `classify()` tested `catchment`
  before `scenario`, so "…within 800m?" matched `within \d+ ?m` and silently ran the Kashmere
  Gate 500 m fixture. **Fix:** test `scenario` before `catchment` in `lib/demo/queries.ts`.
  Verified: the scenario query now enters pick-a-point mode.
- **B3 — history silently replaced.** Each new query reset `state.results` with no archiving.
  **Fix:** `useQueryRunner` now archives the prior completed turn into `state.history`;
  `ChatPane` renders archived turns above the current one, desaturated (§8.1 Scene 5).
  Verified: prior turn's bubble + cards persist after a follow-up.
- **B4 — dead white strip on wide windows.** The GL canvas kept a stale width on window
  resize. **Fix:** a `window.resize` handler in `MapView` calls `map.resize()`. (Code fix;
  not visually reproducible in the narrow preview pane.)
- **B5 — camera didn't frame the answer.** The worst-wards layer used a fixed full-NCR camera.
  **Fix:** `CameraSpec` gained an optional `bounds` extent; `wardHighlightLayer` computes the
  bbox of the selected wards (via `bboxOf` in `lib/geo.ts`); the conductor `fitBounds` to it
  with padding clamped to the pane. Verified: the camera now frames the Delhi/NCR ward extent.
- **Bonus:** `ResultSkeleton` was a plain function component inside
  `<AnimatePresence mode="popLayout">`, flooding a "Function components cannot be given refs"
  warning. Wrapped in `forwardRef`. Verified: 0 warnings.

The **remaining** BUGS.md items are a design-system migration, not functional bugs: U1–U5
(contrast/alertInk/slate-bubble polish) and D1–D8 (the DESIGN.md v2 token/font/dark-mode
overhaul). These are a separate, larger effort and are untouched here.

---

## 9. Suggested priorities for the next session

1. Stand up and verify the **live backend** end-to-end (Supabase + Groq + Gemini) — the demo
   path is proven, the live path is not.
2. Add a **smoke test** (`/health`, `/query/demo`, one live `/query/stream`) — still zero
   automated verification anywhere.
3. Codegen or otherwise **auto-sync** `packages/contract` ↔ `apps/api/schemas.py`.
4. Delete the **legacy V1 trees** (§6) once nothing imports from them.
5. Work the DESIGN.md v2 migration (BUGS.md D1–D8, U1–U5) as its own sprint.
6. Verify the RS pipeline + pgvector embeddings are actually populated in the live Supabase DB.

# DEPLOY.md — Propus deployment (Vercel · Netlify · Render)

How to ship Propus to free-tier hosting. Read the **Two ways to deploy** section
first — it decides how much you actually need to stand up.

---

## Two ways to deploy

Propus has a hard split (CLAUDE.md §5.2) that makes deployment easy:

| Mode | What it needs | Use it for |
|---|---|---|
| **Demo** (recommended for the pitch) | **Frontend only.** No backend, no database, no API keys. Runs on committed fixtures (`apps/web/public/fixtures/`) + recorded event streams (`apps/web/lib/demo/`). | The live pitch. A model or DB outage **cannot** kill it. |
| **Live** | Frontend **+** FastAPI backend (Render) **+** Supabase Postgres/PostGIS **+** model keys (Groq / Gemini). | Free-form natural-language queries against real data. |

> Deploy **demo mode first** — it's a 5-minute, one-service deploy. Add live mode
> later by standing up the backend and flipping one env var.

Architecture when fully live:

```
Vercel / Netlify (Next.js)  ──SSE──▶  Render (FastAPI + agent)  ──▶  Supabase (PostGIS)
        │  NEXT_PUBLIC_MODE=live                │  GROQ / GOOGLE keys
        │  NEXT_PUBLIC_API_URL=<render url>     │  DATABASE_URL / AGENT_DATABASE_URL
```

---

## Repo facts you need

- **Monorepo, npm workspaces** (`apps/*`, `packages/*`). Root `package.json` owns
  the workspaces and the lockfile.
- **Frontend**: `apps/web` — Next.js 14 (App Router). It imports the shared
  `@propus/contract` package as **TypeScript source**, transpiled via
  `transpilePackages` in `apps/web/next.config.mjs`. So the build must run from a
  context where the `packages/contract` workspace resolves (i.e. the repo root
  lockfile is used).
- **Backend**: `apps/api` — FastAPI app object `apps.api.main:app`. It uses
  **relative package imports** (`from .formatters import …`), so it must be launched
  from the **repo root**, not from inside `apps/api`.
- **Fixtures are committed** (`apps/web/public/fixtures/*.geojson`, `stops.json`) and
  served as static files — demo mode needs no build step to produce them.
- **Node 20**, **Python 3.11+**.

---

## 1 · Frontend — Vercel (recommended)

Per CLAUDE.md §4 the frontend targets **Vercel Hobby (free)**.

### Project settings

| Setting | Value |
|---|---|
| Framework Preset | **Next.js** |
| Root Directory | **`apps/web`** (enable "Include files outside the root directory" so the `packages/contract` workspace is available) |
| Install Command | *(leave default — Vercel installs from the root lockfile it detects for the workspace)* |
| Build Command | *(default `next build`)* |
| Node.js Version | **20.x** |

> If the workspace `@propus/contract` fails to resolve during build, switch Root
> Directory back to the **repo root** and set Build Command to
> `npm run build` (which runs `next build --workspace apps/web`) and Output
> Directory to `apps/web/.next`.

### Environment variables (Vercel → Settings → Environment Variables)

| Name | Demo value | Live value |
|---|---|---|
| `NEXT_PUBLIC_MODE` | `demo` | `live` |
| `NEXT_PUBLIC_API_URL` | *(unset)* | `https://<your-render-service>.onrender.com` |

`NEXT_PUBLIC_*` vars are inlined at **build time** — after changing them, trigger a
redeploy.

### Deploy

Push to the connected branch, or:

```bash
npm i -g vercel
vercel        # first run: link project, set Root Directory = apps/web
vercel --prod
```

---

## 2 · Frontend — Netlify (alternative)

Netlify runs Next.js via the official `@netlify/plugin-nextjs` (auto-installed when
the framework is detected).

Commit this `netlify.toml` at the **repo root**:

```toml
[build]
  base = "."
  command = "npm run build"
  publish = "apps/web/.next"

[build.environment]
  NODE_VERSION = "20"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

Then in **Site settings → Environment variables** set the same vars as Vercel:
`NEXT_PUBLIC_MODE` (`demo` or `live`) and, for live, `NEXT_PUBLIC_API_URL`.

CLI:

```bash
npm i -g netlify-cli
netlify deploy         # preview
netlify deploy --prod
```

> Keep `base = "."` (repo root) so the npm workspace and `packages/contract` resolve.
> Netlify installs from the root lockfile.

---

## 3 · Backend — Render (live mode only)

Skip this entirely for a demo-mode deploy.

Per CLAUDE.md §4 the backend targets **Render free web service** (accept cold starts).

### Service settings

| Setting | Value |
|---|---|
| Type | **Web Service** |
| Runtime | **Python 3** |
| Root Directory | **repo root** (blank) — the app is imported as `apps.api.main:app` |
| Build Command | see below |
| Start Command | `uvicorn apps.api.main:app --host 0.0.0.0 --port $PORT` |
| Instance Type | Free |
| Health Check Path | `/health` |

**Build Command.** `apps/api/requirements.txt` only covers the FastAPI surface
(fastapi, uvicorn, pydantic, httpx). The **agent** (live queries) also needs its ML/DB
deps, so install both:

```bash
pip install -r apps/api/requirements.txt && \
pip install google-adk google-generativeai sqlalchemy psycopg2-binary shapely geopandas
```

> `geopandas`/`shapely` pull in GDAL/GEOS and lengthen cold builds. If your build
> times out on the free tier, trim to what the agent's live queries actually import.

### Environment variables (Render → Environment)

| Name | Required for | Notes |
|---|---|---|
| `GROQ_API_KEY` | simple-tier queries | free key: <https://console.groq.com/keys> |
| `GOOGLE_API_KEY` | advanced-tier (Gemini) | scenario / multi-step reasoning |
| `DATABASE_URL` | data queries | Supabase Postgres/PostGIS connection string |
| `AGENT_DATABASE_URL` | data queries | **read-only**, table-allowlisted, 5s-timeout role (`db/roles.sql`); the agent uses this in preference to `DATABASE_URL` |

Without `GROQ_API_KEY` the agent falls back to Gemini for all tiers.

### `render.yaml` (optional Blueprint)

Commit at repo root to deploy via Render Blueprints instead of the dashboard:

```yaml
services:
  - type: web
    name: propus-api
    runtime: python
    plan: free
    healthCheckPath: /health
    buildCommand: >-
      pip install -r apps/api/requirements.txt &&
      pip install google-adk google-generativeai sqlalchemy psycopg2-binary shapely geopandas
    startCommand: uvicorn apps.api.main:app --host 0.0.0.0 --port $PORT
    envVars:
      - key: GROQ_API_KEY
        sync: false
      - key: GOOGLE_API_KEY
        sync: false
      - key: DATABASE_URL
        sync: false
      - key: AGENT_DATABASE_URL
        sync: false
```

### Two production hardening steps

1. **CORS.** `apps/api/main.py` currently sets `allow_origins=["*"]`. Before going
   public, restrict it to your Vercel/Netlify origin.
2. **Keep-warm.** Render free sleeps after ~15 min idle, and the observed cold start on
   this backend can exceed 60s (the `google-adk` import chain is heavier than a bare
   FastAPI app). `.github/workflows/keep-warm.yml` pings `/health` every 10 min so the
   instance essentially never sleeps during normal hours — no setup needed, it runs
   automatically once this repo is on GitHub. Use its "Run workflow" button (Actions tab)
   to force an immediate wake-up, and **still hit the URL yourself before walking into the
   pitch** (CLAUDE.md §5.5) — a scheduled cron can slip a few minutes.

---

## 4 · Database — Supabase (live mode only)

Free tier, 500 MB. **Load only derived tables** — never raw `stop_times` (~3.7M rows),
CLAUDE.md §4/§12.

1. Create a Supabase project → copy the connection string into `DATABASE_URL`.
2. Apply `db/schema.sql` (derived tables + PostGIS functions), then `db/roles.sql`
   (creates the read-only, allowlisted `propus_agent_ro` role) and use that role's
   connection string for `AGENT_DATABASE_URL`.
3. Load the derived tables (`ward_metrics`, ward geometry, stop points, route lines)
   via the `pipeline/` scripts.

The frontend never talks to the database directly — only the Render API does.

### Schema changes after the first deploy — always via `db/migrations/`

`db/schema.sql` uses `CREATE TABLE IF NOT EXISTS` throughout, which is correct for a
fresh database but a **silent no-op** against a table that already exists — Postgres
will not retrofit a new column onto an existing table just because `schema.sql`
gained one. Re-running `schema.sql` against an already-provisioned instance does
**not** apply the change; it looks like it worked (every statement prints
`CREATE TABLE`/`skipping`) and the new column or table simply isn't there. This bit
us for real: `db/migrations/001_physical_stop_dedup.sql` exists because a schema
change shipped in `schema.sql` without a matching migration, and production ran for
a day throwing `UndefinedColumn` on every worst-wards/density-rank query before
anyone noticed — the failure mode is "queries silently error at request time," not
"the deploy fails," so it's easy to miss.

**The rule going forward:** any change to `db/schema.sql` that adds a column/table to
an object that may already exist live also gets a same-PR file in
`db/migrations/NNN_description.sql`, written with `ADD COLUMN IF NOT EXISTS` /
`CREATE TABLE IF NOT EXISTS` (so it's a no-op on a fresh DB that already matches
current `schema.sql`), and it gets **run against the live `DATABASE_URL`** as part
of that deploy — `git push` alone never touches Supabase.
`db/functions.sql` doesn't have this problem: every function there is
`CREATE OR REPLACE FUNCTION`, so simply re-running the whole file after any change
is always correct.

---

## 5 · Environment variable reference

| Variable | Side | Mode | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_MODE` | frontend | both | `demo` (fixtures) or `live` (calls the API) |
| `NEXT_PUBLIC_API_URL` | frontend | live | Base URL of the Render API |
| `GROQ_API_KEY` | backend | live | Cheap open-source models for simple queries |
| `GOOGLE_API_KEY` | backend | live | Gemini for advanced queries |
| `DATABASE_URL` | backend | live | Supabase owner/loader connection |
| `AGENT_DATABASE_URL` | backend | live | Read-only agent role connection |

No secrets are committed. `.env.example` lists names only; each platform holds the real
values in its own encrypted store.

---

## 6 · Post-deploy checklist

**Demo (frontend only):**
- [ ] Site loads; landing map frames Delhi with the metro network.
- [ ] Run a headline query (e.g. "Which wards have the worst transit access?") →
      table + choropleth + stat cards render.
- [ ] Fixtures load (Network tab shows `200` for `/fixtures/*.geojson`, `stops.json`).

**Live (adds backend):**
- [ ] `GET https://<render-url>/health` → `{"status":"ok", ...}`.
- [ ] Frontend `NEXT_PUBLIC_MODE=live` and `NEXT_PUBLIC_API_URL` point at the Render URL
      (rebuild after changing).
- [ ] A live query streams results (chip → results); the "LIVE" badge shows in the top bar.
- [ ] Browser console shows **no CORS errors** against the Render origin.

---

## 7 · Common gotchas

- **Blank/500 on the frontend build**: the `@propus/contract` workspace didn't resolve.
  Deploy from the repo root (root lockfile) or enable "include files outside root".
- **`ModuleNotFoundError: apps` on Render**: start command run from the wrong directory.
  Keep Root Directory at the repo root and launch `apps.api.main:app`.
- **Live queries 404 / network error but demo works**: `NEXT_PUBLIC_API_URL` unset or
  stale (it's build-time — redeploy the frontend after setting it), or the Render service
  is cold — retry after ~30s.
- **CORS blocked**: restrict `allow_origins` to your real frontend origin (or, temporarily,
  confirm it's still `["*"]`).
- **Env var change didn't take effect on the frontend**: `NEXT_PUBLIC_*` are inlined at
  build time — you must redeploy, not just restart.

---

## Note — existing GCP path

The repo also carries a Google Cloud Run setup (`cloud-run/`, `deploy.sh`) from an earlier
deployment. This document covers the free-tier Vercel/Netlify + Render path from CLAUDE.md
§4; the two are independent — pick one.

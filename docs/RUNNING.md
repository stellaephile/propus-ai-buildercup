# Running Propus locally

How to start the FastAPI backend (`apps/api`) and the Next.js frontend (`apps/web`)
by hand. (In Claude Code sessions the same servers can be started via
`.claude/launch.json` — names `api` and `web` — which uses the exact commands below.)

## Prerequisites

- **Python 3.12** with the repo venv at `.venv/` (create with `python3 -m venv .venv`,
  then `pip install -r apps/api/requirements.txt -r requirements_agent.txt`)
- **Node 18+** (repo tested with Node 24)
- A root `.env` (copy `.env.example`) with at least:

  | Variable | Purpose |
  |---|---|
  | `AGENT_DATABASE_URL` | Supabase Postgres, **read-only agent role** — what the agent queries |
  | `DATABASE_URL` | Admin/pipeline connection; also the fallback if `AGENT_DATABASE_URL` is unset (logs a loud warning) |
  | `GOOGLE_API_KEY` | Gemini — the advanced-tier model |
  | `GROQ_API_KEY` | Optional. Groq (open-source Llama) for the simple tier; without it, simple queries fall back to Gemini |

  Never commit `.env` — names only in `.env.example`.

## Backend (FastAPI + agent)

From the **repo root** (the module path and `.env` loading depend on it):

```bash
.venv/bin/uvicorn apps.api.main:app --host 0.0.0.0 --port 8010 --reload
```

Verify it's up:

```bash
curl http://localhost:8010/health
# → {"status":"ok","database":"configured",...}
```

Endpoints:

- `POST /query/stream` — SSE stream of typed `PropusEvent`s (the real path)
- `GET /query/demo` — canned `PropusResult[]`, no DB/LLM needed
- `GET /health` — health check

The port is **8010** by convention (matches `.claude/launch.json` and
`apps/web/.env.example`); if you change it, change `NEXT_PUBLIC_API_URL` to match.

## Frontend (Next.js)

Install workspace deps once, from the repo root:

```bash
npm install
```

The frontend has two modes:

- **Demo mode (default)** — replays recorded/fixture streams; needs **no backend**.
- **Live mode** — streams from the FastAPI agent. Create `apps/web/.env.local`
  (copy `apps/web/.env.example`):

  ```bash
  NEXT_PUBLIC_API_URL=http://localhost:8010
  NEXT_PUBLIC_MODE=live
  ```

Then start it (repo root):

```bash
npm run dev          # runs next dev in apps/web → http://localhost:3000
```

## Both together (live mode)

Two terminals, both at the repo root:

```bash
# terminal 1 — backend
.venv/bin/uvicorn apps.api.main:app --host 0.0.0.0 --port 8010 --reload

# terminal 2 — frontend
npm run dev
```

Open http://localhost:3000. If live queries fail, check in order:
`curl localhost:8010/health` → backend up? · `apps/web/.env.local` present with
`NEXT_PUBLIC_MODE=live`? (restart `next dev` after editing it) · backend logs for
`AGENT_DATABASE_URL` / `GOOGLE_API_KEY` warnings.

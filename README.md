# Propus — Delhi Transit Intelligence

A natural-language agent over Delhi's bus (DTC) and metro (DMRC) GTFS data, Delhi ward
boundaries, and Sentinel-2/WorldPop remote-sensing layers. Built for WRI India to surface
transit-equity questions ("which wards are underserved," "how far is X from a metro,"
"where are the multimodal gaps") without writing SQL.

**Start here for the real technical picture:** [ARCHITECTURE.md](ARCHITECTURE.md). It's the
canonical, up-to-date doc — everything else in this repo's root (`DEPLOYMENT*.md`,
`GCP_DEPLOYMENT.md`, `SETUP_SUMMARY.md`, etc.) is a stale scratch file from earlier sessions
and may contradict what's actually in the code. Don't trust them; trust ARCHITECTURE.md and
the code itself.

## What's in this repo

| Piece | Where | Status |
|---|---|---|
| GTFS ingest + ward metrics pipeline | `pipeline/` | Implemented, verified against a real DB load (see [status/day2_summary.md](status/day2_summary.md)) |
| Remote-sensing pipeline (WorldPop, Sentinel-2) | `pipeline/rs_*.py` | Implemented, run status against the live DB **not verified this session** |
| ADK agent (Gemini, 11 tools incl. geocoding fallback) | `agent/agent.py` | Implemented, no automated tests |
| FastAPI backend | `api/main.py` | Implemented, has a database-less mock mode |
| Streamlit frontend | `frontend/app.py`, `frontend/map_utils.py` | Implemented |
| MCP server | `mcp_server/server.py` | Exists, but **not actually run as a server** in the current deployment — see ARCHITECTURE.md |
| Database schema (DDL) | — | **Missing from the repo.** Pipeline scripts assume `schema.sql` has been applied, but no such file exists anywhere in git history. |
| Automated tests | — | None. |

## Quick start (local dev)

> **Current stack (Next.js + FastAPI under `apps/`):** see
> [docs/RUNNING.md](docs/RUNNING.md). The steps below are for the legacy
> Streamlit stack.

```bash
# 1. Env vars (see ARCHITECTURE.md for the full list)
cp cloud-run/fastapi/.env.template .env
# fill in DATABASE_URL, GOOGLE_API_KEY / Vertex creds, GOOGLE_MAPS_API_KEY

# 2. Backend
pip install -r requirements_agent.txt
uvicorn api.main:app --reload --port 8000

# 3. Frontend (separate shell)
pip install -r requirements_agent.txt
streamlit run frontend/app.py
```

Agent can also be driven directly from the terminal without the API/frontend:
```bash
python agent/agent.py --query "Which wards have the worst transit access?"
```

## Data attribution & audience

- [ATTRIBUTION.md](ATTRIBUTION.md) — data sources and licenses (OTD Delhi, DMRC, OSM, ward boundaries)

## Deployment

Two working deploy scripts, run in order:
```bash
cd cloud-run/fastapi  && bash deploy.sh <PROJECT_ID> <REGION>
cd cloud-run/streamlit && bash deploy.sh <PROJECT_ID> <REGION> <BACKEND_URL>
```
Or `cloud-run/deploy-all.sh <PROJECT_ID> <REGION>` to do both. **Do not** use
`docker-compose.yml`, `cloudbuild.yaml`, or the root `deploy.sh` — they reference a
`Dockerfile.fastapi` that doesn't exist in this repo and will fail. Details in
[ARCHITECTURE.md](ARCHITECTURE.md#deployment-reality-check).

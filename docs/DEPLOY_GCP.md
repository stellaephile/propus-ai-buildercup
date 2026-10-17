# Deploying Propus to Google Cloud Run

Two Cloud Run services from one repo: `propus-api` (FastAPI + ADK agent on Gemini via
Vertex AI) and `propus-web` (Next.js). Data stays in Supabase (PostGIS). Questions are logged
to Firestore. No key or secret is stored in the repo or in an image.

```
Browser ──▶ propus-web (Cloud Run) ──SSE──▶ propus-api (Cloud Run) ──▶ Supabase PostGIS
                                                │                        (read-only role)
                                                ├──▶ Vertex AI (Gemini)   service-account auth
                                                └──▶ Firestore (query_log)
```

## One-off setup

Replace `PROJECT` and `REGION` (default region `asia-south1`).

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com secretmanager.googleapis.com --project PROJECT

# Firestore for the query log
gcloud firestore databases create --project PROJECT --location REGION

# Read-only database role (db/roles.sql), then store its connection string as a secret.
# The agent must connect as propus_agent_ro, never the owner (statement_timeout 5s, SELECT-only).
printf '%s' 'postgresql://propus_agent_ro.<ref>:<password>@<pooler-host>:5432/postgres' \
  | gcloud secrets create propus-agent-database-url --project PROJECT --data-file=-
```

## Deploy

```bash
./deploy/cloudrun.sh PROJECT REGION
```

The script asks before creating anything. It builds both images with Cloud Build (repo-root
context, one copy of each module), grants the `propus-run` service account
`aiplatform.user`, `datastore.user` and `secretmanager.secretAccessor`, deploys the API with
`min-instances=1` and a 300 s request timeout (long enough for streamed answers), then builds
the web app with the API URL baked in and deploys it.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | API env | Gemini through Vertex AI using the service account (no API key) |
| `AGENT_DATABASE_URL` | API, from Secret Manager | Read-only Supabase role |
| `QUERY_LOG_COLLECTION=query_log` | API env | Turns on the Firestore query log; unset locally |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_MODE=live` | web build arg | Where the browser sends questions |

## Verify

```bash
curl https://<propus-api-url>/health
```

Then open the web URL and run the sample questions in the README. Query log entries appear
in Firestore under `query_log` (question text, tools called, outcome, latency, model; no user
identifiers).

## Local equivalent

`gcloud auth application-default login`, set the Vertex variables above in `.env`, then
`uvicorn apps.api.main:app --port 8010` and `npm run dev`.

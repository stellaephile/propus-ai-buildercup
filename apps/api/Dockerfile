# Propus API (FastAPI + ADK agent) for Cloud Run.
# Build context is the REPO ROOT (one copy of every module, CLAUDE.md §10):
#   gcloud builds submit --config deploy/cloudbuild.yaml --substitutions=...
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY apps/api/requirements.txt apps/api/requirements.txt
RUN pip install --upgrade pip && pip install -r apps/api/requirements.txt

COPY apps/api apps/api

# Fail the build, not the first request, if the app cannot be imported. main.py
# loads agent.py lazily, so import both: a tool list naming a function that no
# longer exists once reached production as a live outage.
RUN python -c "import apps.api.main, apps.api.agent"

# Cloud Run injects PORT. Credentials come from the service account (Vertex AI,
# Firestore) and Secret Manager (AGENT_DATABASE_URL); nothing is baked in.
CMD exec uvicorn apps.api.main:app --host 0.0.0.0 --port ${PORT:-8080}

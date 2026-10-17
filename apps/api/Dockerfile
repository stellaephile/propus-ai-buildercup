# Propus API (FastAPI + ADK agent) for Cloud Run.
# Build context is the REPO ROOT (one copy of every module, CLAUDE.md §10):
#   gcloud builds submit --config deploy/cloudbuild.yaml --substitutions=...
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY apps/api/requirements.txt apps/api/requirements.txt
RUN pip install --upgrade pip && pip install -r apps/api/requirements.txt

COPY apps/api apps/api

# Cloud Run injects PORT. Credentials come from the service account (Vertex AI,
# Firestore) and Secret Manager (AGENT_DATABASE_URL); nothing is baked in.
CMD exec uvicorn apps.api.main:app --host 0.0.0.0 --port ${PORT:-8080}

#!/usr/bin/env bash
# Deploy Propus to Cloud Run: API first, then the web app (which needs the API URL
# at build time). Creates billable resources in the chosen project.
#
#   ./deploy/cloudrun.sh <gcp-project-id> [region] [api]   # 'api' skips the web rebuild
#
# Prerequisites (one-off, see docs/DEPLOY_GCP.md):
#   - APIs enabled: run, cloudbuild, artifactregistry, aiplatform, firestore, secretmanager
#   - Secret "propus-agent-database-url" holds the propus_agent_ro connection string
#   - Firestore database exists (gcloud firestore databases create --location=<region>)
# The project id is an argument so it never lands in the repo.
set -euo pipefail

PROJECT="${1:?usage: deploy/cloudrun.sh <gcp-project-id> [region]}"
REGION="${2:-asia-south1}"
VERTEX_LOCATION="${VERTEX_LOCATION:-us-central1}"
REPO="propus"
SA_NAME="propus-run"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
REG="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
cd "$(dirname "$0")/.."

echo "Project: ${PROJECT}  Region: ${REGION}  Vertex AI: ${VERTEX_LOCATION}"
read -r -p "Create/modify billable resources in this project? [y/N] " ok
[[ "${ok}" == "y" ]] || { echo "aborted"; exit 1; }

gcloud artifacts repositories describe "${REPO}" --project "${PROJECT}" --location "${REGION}" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "${REPO}" --project "${PROJECT}" --location "${REGION}" --repository-format docker

gcloud iam service-accounts describe "${SA}" --project "${PROJECT}" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "${SA_NAME}" --project "${PROJECT}" --display-name "Propus Cloud Run"
# A new service account can take a few seconds to become visible to IAM, so retry.
for role in roles/aiplatform.user roles/datastore.user roles/secretmanager.secretAccessor; do
  for attempt in 1 2 3 4 5 6; do
    gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${SA}" \
      --role "${role}" --condition=None >/dev/null 2>&1 && break
    [[ "${attempt}" == 6 ]] && { echo "could not grant ${role} to ${SA}"; exit 1; }
    sleep 10
  done
done

# CORS: allow only the web app's own origins (Cloud Run serves it on two URLs).
# Empty on a first deploy, when the web service does not exist yet; the API then
# allows any origin until the next run.
WEB_ORIGINS="$(gcloud run services describe propus-web --project "${PROJECT}" --region "${REGION}" \
  --format 'value(metadata.annotations."run.googleapis.com/urls")' 2>/dev/null | tr -d '[]" ' || true)"

echo "== API"
gcloud builds submit --project "${PROJECT}" --config deploy/cloudbuild.yaml \
  --substitutions "_DOCKERFILE=apps/api/Dockerfile,_IMAGE=${REG}/api:latest" .
gcloud run deploy propus-api --project "${PROJECT}" --region "${REGION}" \
  --image "${REG}/api:latest" --service-account "${SA}" \
  --allow-unauthenticated --min-instances 1 --max-instances 3 \
  --cpu 1 --memory 1Gi --timeout 300 --concurrency 20 \
  --set-env-vars "^|^GOOGLE_GENAI_USE_VERTEXAI=true|GOOGLE_CLOUD_PROJECT=${PROJECT}|GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION}|QUERY_LOG_COLLECTION=query_log${WEB_ORIGINS:+|CORS_ORIGINS=${WEB_ORIGINS}}" \
  --set-secrets "AGENT_DATABASE_URL=propus-agent-database-url:latest"
API_URL="$(gcloud run services describe propus-api --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"

if [[ "${3:-all}" == "api" ]]; then echo "API only: ${API_URL}/health"; exit 0; fi

echo "== Web (API: ${API_URL})"
gcloud builds submit --project "${PROJECT}" --config deploy/cloudbuild.yaml \
  --substitutions "_DOCKERFILE=apps/web/Dockerfile,_IMAGE=${REG}/web:latest,_API_URL=${API_URL}" .
gcloud run deploy propus-web --project "${PROJECT}" --region "${REGION}" \
  --image "${REG}/web:latest" --service-account "${SA}" \
  --allow-unauthenticated --min-instances 1 --max-instances 3 \
  --cpu 1 --memory 1Gi --timeout 60

echo
echo "Web: $(gcloud run services describe propus-web --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"
echo "API: ${API_URL}/health"

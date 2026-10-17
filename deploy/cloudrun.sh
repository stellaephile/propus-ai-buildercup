#!/usr/bin/env bash
# Deploy Propus to Cloud Run: API first, then the web app (which needs the API URL
# at build time). Creates billable resources in the chosen project.
#
#   ./deploy/cloudrun.sh <gcp-project-id> [region]
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
for role in roles/aiplatform.user roles/datastore.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "${PROJECT}" --member "serviceAccount:${SA}" --role "${role}" --condition=None >/dev/null
done

echo "== API"
gcloud builds submit --project "${PROJECT}" --config deploy/cloudbuild.yaml \
  --substitutions "_DOCKERFILE=apps/api/Dockerfile,_IMAGE=${REG}/api:latest" .
gcloud run deploy propus-api --project "${PROJECT}" --region "${REGION}" \
  --image "${REG}/api:latest" --service-account "${SA}" \
  --allow-unauthenticated --min-instances 1 --max-instances 3 \
  --cpu 1 --memory 1Gi --timeout 300 --concurrency 20 \
  --set-env-vars "GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=${PROJECT},GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION},QUERY_LOG_COLLECTION=query_log" \
  --set-secrets "AGENT_DATABASE_URL=propus-agent-database-url:latest"
API_URL="$(gcloud run services describe propus-api --project "${PROJECT}" --region "${REGION}" --format 'value(status.url)')"

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

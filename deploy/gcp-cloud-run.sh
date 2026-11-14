#!/usr/bin/env bash
# Deploy PriceTide to Google Cloud Run, with Cloud Scheduler calling /jobs/tick every minute.
#
# See DEPLOY.md, "Option B: Google Cloud Run". Run it from the repo root in Google Cloud Shell (gcloud is already installed and signed in there):
#   bash deploy/gcp-cloud-run.sh
#
# It is safe to run again: it updates what exists and only generates secrets that don't exist yet.
# Values can be passed as environment variables to skip the prompts:
#   PROJECT_ID, REGION, SERVICE, SHOPIFY_API_KEY, SUPPORT_EMAIL, APP_OWNER_NAME
# The Shopify API secret and the database URL are always asked for silently (never echoed),
# unless their Secret Manager entries already exist.
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-pricetide}"
TICK_JOB="${SERVICE}-tick"

ask() { # ask VAR "Question" [silent]
  local var="$1" question="$2" silent="${3:-}"
  if [[ -n "${!var:-}" ]]; then return; fi
  if [[ -n "$silent" ]]; then read -r -s -p "$question: " "$var"; echo; else read -r -p "$question: " "$var"; fi
  if [[ -z "${!var}" ]]; then echo "  $var is required." >&2; exit 1; fi
}

secret_exists() { gcloud secrets describe "$1" --project "$PROJECT_ID" >/dev/null 2>&1; }

# put_secret NAME VALUE  -> creates the secret, or adds a new version if it exists
put_secret() {
  if secret_exists "$1"; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --project "$PROJECT_ID" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --project "$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
  fi
}

[[ -f shopify.app.toml && -f Dockerfile ]] || { echo "Run this from the PriceTide repo root." >&2; exit 1; }

ask PROJECT_ID "Google Cloud project ID"
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
APP_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "==> Enabling APIs (first time takes a minute or two)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com >/dev/null

echo "==> Secrets"
ask SHOPIFY_API_KEY "Shopify client ID (Dev Dashboard > price-tide > Credentials)"
if ! secret_exists pricetide-shopify-api-secret; then
  ask SHOPIFY_API_SECRET "Shopify client secret" silent
  put_secret pricetide-shopify-api-secret "$SHOPIFY_API_SECRET"
fi
if ! secret_exists pricetide-database-url; then
  ask DATABASE_URL "App DATABASE_URL (pooled connection string)" silent
  put_secret pricetide-database-url "$DATABASE_URL"
fi
# DIRECT_URL (non-pooled) is used only by `npm run migrate:deploy`. Neon: the host without -pooler.
# Leave it empty if your pooled URL also supports migrations (e.g. Supabase session pooler).
if ! secret_exists pricetide-direct-url; then
  if [[ -z "${DIRECT_URL+x}" ]]; then read -r -s -p "Direct (non-pooled) URL for migrations, or Enter to skip: " DIRECT_URL; echo; fi
  put_secret pricetide-direct-url "${DIRECT_URL:-${DATABASE_URL:-$(gcloud secrets versions access latest --secret pricetide-database-url)}}"
fi
# Generated once and never replaced: replacing the encryption key would make stored shop tokens unreadable.
if ! secret_exists pricetide-token-keys; then
  put_secret pricetide-token-keys "k1:$(openssl rand -base64 32)"
  echo "  generated pricetide-token-keys"
fi
if ! secret_exists pricetide-cron-secret; then
  put_secret pricetide-cron-secret "$(openssl rand -hex 32)"
  echo "  generated pricetide-cron-secret"
fi
for s in pricetide-shopify-api-secret pricetide-database-url pricetide-direct-url pricetide-token-keys pricetide-cron-secret; do
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

ask SUPPORT_EMAIL "Support email (shown on the /privacy page and to merchants)"
ask APP_OWNER_NAME "Your name as the app owner (shown on /privacy)"

echo "==> Building and deploying to Cloud Run ($APP_URL)"
# Request-based billing + scale to zero keeps this inside the free tier at low traffic.
# The per-minute tick keeps an instance warm most of the time, so admin pages rarely cold-start.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 3000 \
  --cpu 1 --memory 512Mi \
  --min-instances 0 --max-instances 2 \
  --timeout 300 \
  --set-env-vars "^|^NODE_ENV=production|SHOPIFY_API_KEY=${SHOPIFY_API_KEY}|SHOPIFY_APP_URL=${APP_URL}|SCOPES=write_products|SUPPORT_EMAIL=${SUPPORT_EMAIL}|APP_OWNER_NAME=${APP_OWNER_NAME}|SCHEDULER_ENABLED=false|LOG_LEVEL=info" \
  --set-secrets "SHOPIFY_API_SECRET=pricetide-shopify-api-secret:latest,DATABASE_URL=pricetide-database-url:latest,DIRECT_URL=pricetide-direct-url:latest,TOKEN_ENCRYPTION_KEYS=pricetide-token-keys:latest,CRON_SECRET=pricetide-cron-secret:latest"

echo "==> Checking health"
if curl -fsS --max-time 60 "${APP_URL}/healthz" >/dev/null; then echo "  ${APP_URL}/healthz OK"; else
  echo "  Health check failed. Logs: gcloud run services logs read $SERVICE --region $REGION --limit 50" >&2; exit 1; fi

echo "==> Cloud Scheduler: POST /jobs/tick every minute"
CRON_SECRET_VALUE="$(gcloud secrets versions access latest --secret pricetide-cron-secret)"
if gcloud scheduler jobs describe "$TICK_JOB" --location "$REGION" >/dev/null 2>&1; then verb=update; else verb=create; fi
gcloud scheduler jobs "$verb" http "$TICK_JOB" \
  --location "$REGION" \
  --schedule "* * * * *" \
  --time-zone "Etc/UTC" \
  --uri "${APP_URL}/jobs/tick" \
  --http-method POST \
  --attempt-deadline 300s \
  --$([[ $verb == create ]] && echo headers || echo update-headers) "Authorization=Bearer ${CRON_SECRET_VALUE}" >/dev/null
unset CRON_SECRET_VALUE
echo "  scheduler job ${TICK_JOB}: ${verb} done"

echo "==> Writing the app URL into shopify.app.toml"
python3 - "$APP_URL" <<'PY'
import re, sys
url = sys.argv[1]
path = "shopify.app.toml"
text = open(path).read()
line = f'application_url = "{url}"'
if re.search(r'^application_url\s*=.*$', text, re.M):
    text = re.sub(r'^application_url\s*=.*$', line, text, flags=re.M)
else:
    text = re.sub(r'^(embedded\s*=.*)$', line + r'\n\1', text, count=1, flags=re.M)
redirects = f'redirect_urls = [ "{url}/auth/callback" ]'
if re.search(r'^\[auth\]', text, re.M):
    text = re.sub(r'^redirect_urls\s*=.*$', redirects, text, flags=re.M)
else:
    text = text.rstrip() + f"\n\n[auth]\n{redirects}\n"
open(path, "w").write(text)
PY
grep -E '^(application_url|redirect_urls)' shopify.app.toml | sed 's/^/  /'

cat <<EOF

Done. App URL: ${APP_URL}

Next (also fine to run here in Cloud Shell):
  1. npm run config:link   first time only: sign in to Shopify and pick the price-tide app
  2. npm run deploy        pushes the URL, scopes and webhooks to Shopify
  3. Commit shopify.app.toml (production URLs). Keep using shopify.app.dev.toml for npm run dev.
  4. Install on pricetide-dev and work through the test list in README.md.
  5. Budget alert: Google Cloud Console > Billing > Budgets & alerts > \$5.
EOF

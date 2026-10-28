#!/bin/sh
# Nightly logical backup of the production database (in addition to Neon's point-in-time restore).
# Run from cron on the VM: see DEPLOY.md "Backups". Keeps the last 14 dumps in BACKUP_DIR.
# The dump holds shop domains, sale settings and prices; Shopify tokens inside it are encrypted with
# TOKEN_ENCRYPTION_KEYS, which is NOT in the dump (keep the keys backed up separately).
set -eu

cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pricetide}"
KEEP="${KEEP:-14}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/pricetide-$(date -u +%Y%m%dT%H%M%SZ).dump"

# pg_dump runs in a container and reads DIRECT_URL (non-pooled) from the root .env.production, so the URL
# never appears in the process list or shell history. pg_dump 17 also dumps older servers.
docker run --rm --env-file ../.env.production public.ecr.aws/docker/library/postgres:17-alpine \
  sh -c 'pg_dump --format=custom --no-owner --dbname="${DIRECT_URL:-$DATABASE_URL}"' > "$file.tmp"
mv "$file.tmp" "$file"
chmod 600 "$file"

# Keep only the newest $KEEP dumps.
ls -1t "$BACKUP_DIR"/pricetide-*.dump | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "Backup written: $file ($(du -h "$file" | cut -f1))"

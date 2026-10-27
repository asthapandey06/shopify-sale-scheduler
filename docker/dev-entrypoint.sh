#!/bin/sh
# Dev container entrypoint: install dependencies when package-lock.json changes, then run the command.
set -eu

stamp=node_modules/.package-lock.sha256
hash=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$hash" ]; then
  echo "Installing dependencies (package-lock.json changed)..."
  npm ci
  echo "$hash" > "$stamp"
fi

npx prisma generate >/dev/null
exec "$@"

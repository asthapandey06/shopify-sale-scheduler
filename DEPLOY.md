# Deploying PriceTide (Oracle Cloud VM + Docker + Neon)

Production setup: one Oracle Cloud **Ampere A1 (ARM64)** VM running Docker, with **Caddy** in front for
automatic HTTPS, and a **Neon** PostgreSQL database. The scheduler runs inside the app container, so the
container must stay up for sales to start and end on time.

```
merchant ── Shopify admin ──https──▶ Caddy :443 ──▶ app :3000 ──▶ Neon (pooled URL)
                                     (deploy/Caddyfile)          migrations ──▶ Neon (direct URL)
```

Files used: `Dockerfile`, `deploy/compose.prod.yaml`, `deploy/Caddyfile`, `deploy/backup.sh`.
Operations and incidents: `RUNBOOK.md`.

---

## 0. Before you start

- A domain you control, e.g. `app.pricetide.example` (one subdomain for the app).
- An Oracle Cloud account, a Neon account, and your Shopify Partner account.
- **A separate development app.** `shopify.app.toml` has `automatically_update_urls_on_dev = true`: if you run
  `npm run dev` against the production app, the CLI repoints the live app at your dev tunnel. In the Partner
  Dashboard create a second app ("PriceTide (dev)"), then on your dev machine:
  ```bash
  npm run config:link        # link to the dev app; save as shopify.app.dev.toml
  npm run config:use shopify.app.dev.toml
  ```
  From then on `npm run dev` uses the dev app, and `shopify.app.toml` stays the production config.

## 1. Database (Neon)

1. Create a project **pricetide-prod** (Postgres 17) in the region closest to your VM
   (e.g. AWS Frankfurt for an Oracle Frankfurt VM).
2. Copy two connection strings from **Connect**:
   - **Pooled** (host contains `-pooler`): the app's `DATABASE_URL`. Append
     `?sslmode=require&connect_timeout=15` (computes scale to zero and take a few seconds to wake).
   - **Direct** (no `-pooler`): `DIRECT_URL`, used only for migrations and backups. Append `?sslmode=require`.
3. Keep the default database user for the app (it owns the schema; migrations need it).

Neon also gives you point-in-time restore (history window depends on your plan; the free plan is short, so
also run the nightly backup in step 8).

## 2. The VM (Oracle Cloud)

1. **Create instance**: image *Ubuntu 24.04*, shape *VM.Standard.A1.Flex* (e.g. 2 OCPU, 12 GB; within
   Always Free limits), add your SSH key, and **reserve a public IP** (Networking › Reserved public IPs) so it
   never changes.
2. **Open ports 80 and 443** in two places:
   - VCN › Security List (or NSG) › Ingress rules: TCP 80 and TCP 443 from `0.0.0.0/0` (and UDP 443 for HTTP/3).
   - The VM's own firewall (Oracle's Ubuntu images block them by default):
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p udp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
3. **Install Docker** (official repository) and updates:
   ```bash
   sudo apt-get update && sudo apt-get -y upgrade && sudo apt-get -y install ca-certificates curl git unattended-upgrades
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
   sudo apt-get update && sudo apt-get -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   sudo usermod -aG docker $USER   # log out and back in
   ```
4. **DNS**: create an `A` record for your app domain pointing at the reserved IP. Wait until
   `dig +short app.pricetide.example` returns it.

## 3. Code and image

```bash
sudo mkdir -p /opt/pricetide && sudo chown $USER /opt/pricetide
git clone https://github.com/asthapandey06/shopify-sale-scheduler.git /opt/pricetide
cd /opt/pricetide
git checkout main                       # the commit you want to release
TAG=$(git rev-parse --short HEAD)
docker build -t pricetide:$TAG .        # builds natively for ARM64 (~5 min)
```

Images are tagged by commit, so every previous release stays on the VM for rollback.

## 4. Production environment

Create one file, `/opt/pricetide/.env.production` (git-ignored; never commit it; `chmod 600 .env.production`).
Docker Compose, the app container and `backup.sh` all read it. The root `.env` is for development only.
Start from `.env.example`:
```
PRICETIDE_TAG=<the TAG from step 3>
APP_DOMAIN=app.pricetide.example
NODE_ENV=production
SHOPIFY_API_KEY=<Partner Dashboard › production app › Client ID>
SHOPIFY_API_SECRET=<Partner Dashboard › Client secret>
SHOPIFY_APP_URL=https://app.pricetide.example
SCOPES=write_products
DATABASE_URL=<Neon pooled URL>?sslmode=require&connect_timeout=15
DIRECT_URL=<Neon direct URL>?sslmode=require
TOKEN_ENCRYPTION_KEYS=k1:<generate, see below>
SUPPORT_EMAIL=<your public support address>
APP_OWNER_NAME=<your legal name or company>
LOG_LEVEL=info
```

Generate the encryption key once and **store a copy in your password manager** (without it, stored Shopify
tokens can't be read; shops would have to re-authenticate):
```bash
node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"
# or, without Node on the VM:
echo "k1:$(openssl rand -base64 32)"
```

Leave `BILLING_TEST_MODE` unset (development stores still get test charges automatically). Defaults apply
for everything else; the full list is in README.md › Environment variables. The app checks all of this at
boot and refuses to start with a list of every problem.

## 5. Start it

```bash
cd /opt/pricetide/deploy
docker compose --env-file ../.env.production -f compose.prod.yaml up -d
docker compose --env-file ../.env.production -f compose.prod.yaml logs -f app     # migrations, then "PriceTide scheduler started"
```

On start the app container runs `prisma migrate deploy` over `DIRECT_URL`, then serves on port 3000. Caddy
waits until the app's health check passes, then gets a Let's Encrypt certificate for `APP_DOMAIN`.

Check from your own computer:
```bash
curl -s https://app.pricetide.example/healthz        # {"ok":true}
curl -sI https://app.pricetide.example/privacy | head -1   # HTTP/2 200
```

## 6. Point Shopify at it (`npm run deploy`)

On your development machine, in `shopify.app.toml` (the production config):
```toml
application_url = "https://app.pricetide.example"

[auth]
redirect_urls = [ "https://app.pricetide.example/auth/callback" ]

[build]
automatically_update_urls_on_dev = false   # production config: never repointed by `npm run dev`
```
Then push the config (URLs, scopes, webhooks) to Shopify:
```bash
npm run config:use shopify.app.toml
npm run deploy        # asks for confirmation; creates a new app version and releases it
```
Commit the `shopify.app.toml` change. Then install the app on a development store from the Partner
Dashboard and run the live test plan in `APP_STORE_SUBMISSION.md` › section 4.

## 7. Health checks and monitoring

- **Container**: the image's `HEALTHCHECK` calls `/healthz` (which queries the database) every 30 s;
  `docker ps` shows `healthy`. `restart: unless-stopped` restarts the app if it crashes and after reboots.
- **External**: add a free uptime monitor (e.g. UptimeRobot or Better Stack) on
  `https://app.pricetide.example/healthz`, every 5 minutes, alerting your email/phone. This is the alarm for
  "the scheduler stopped" or "the database is down" (see RUNBOOK.md).
- **Logs**: JSON lines with secrets redacted, rotated by Docker (20 MB × 10 files):
  `docker compose --env-file ../.env.production -f compose.prod.yaml logs --since 1h app`.
- **OS updates**: `unattended-upgrades` applies security patches; reboot monthly (the stack comes back on its own).

## 8. Backups

Two layers:

1. **Neon point-in-time restore** (Console › Branches › Restore). Before every release that contains a
   migration, also create a branch named `before-<tag>` as an instant restore point.
2. **Nightly dump** on the VM with `deploy/backup.sh` (uses `DIRECT_URL`, keeps 14 days):
   ```bash
   chmod +x /opt/pricetide/deploy/backup.sh
   sudo mkdir -p /var/backups/pricetide && sudo chown $USER /var/backups/pricetide
   (crontab -l 2>/dev/null; echo "15 3 * * * /opt/pricetide/deploy/backup.sh >> /var/backups/pricetide/backup.log 2>&1") | crontab -
   /opt/pricetide/deploy/backup.sh     # run once now to check
   ```
   Copy the dumps off the VM too, e.g. to Oracle Object Storage (free tier) with the OCI CLI:
   `oci os object bulk-upload --bucket-name pricetide-backups --src-dir /var/backups/pricetide --no-overwrite`.

**Restore a dump** (into a new Neon branch or database first, never straight over production):
```bash
docker run --rm -v /var/backups/pricetide:/b:ro public.ecr.aws/docker/library/postgres:17-alpine \
  pg_restore --no-owner --clean --if-exists --dbname="<target DIRECT URL>" /b/<file>.dump
```
Backups contain shop domains, sale settings and prices. Shopify tokens in them are encrypted; keep
`TOKEN_ENCRYPTION_KEYS` in your password manager, not next to the dumps.

## 9. Releasing an update

```bash
cd /opt/pricetide && git fetch && git checkout <commit or tag>
TAG=$(git rev-parse --short HEAD) && docker build -t pricetide:$TAG .
# If this release has a new folder in prisma/migrations: create a Neon branch "before-$TAG" first.
sed -i "s/^PRICETIDE_TAG=.*/PRICETIDE_TAG=$TAG/" .env.production
cd deploy && docker compose --env-file ../.env.production -f compose.prod.yaml up -d
docker compose --env-file ../.env.production -f compose.prod.yaml logs -f app      # migrations, scheduler started, no errors
```
The old container gets SIGTERM, finishes its scheduler pass and releases shop leases (up to ~20 s), then
the new one starts. Expect a few seconds of downtime: Shopify retries webhooks, and the scheduler catches
up on its next pass. Run `npm run deploy` only when `shopify.app.toml` changed.

## 10. Rolling back

```bash
docker images pricetide --format '{{.Tag}}  {{.CreatedSince}}'   # pick the previous tag
sed -i "s/^PRICETIDE_TAG=.*/PRICETIDE_TAG=<previous tag>/" /opt/pricetide/.env.production
cd /opt/pricetide/deploy && docker compose --env-file ../.env.production -f compose.prod.yaml up -d
```
Migrations only move forward. So far they are all additive (new nullable column, index swap), so an older
image runs fine on the newer schema. If a future migration is not backward compatible, roll back by
restoring the `before-<tag>` Neon branch, and say so in that release's notes.

## 11. Rotating `TOKEN_ENCRYPTION_KEYS`

Do this yearly, or immediately if the key may have leaked.

1. Generate a new key: `echo "k2:$(openssl rand -base64 32)"` and save it in your password manager.
2. Put it **first**, keeping the old one: `TOKEN_ENCRYPTION_KEYS=k2:NEW…,k1:OLD…` in
   the root `.env.production`, then `docker compose --env-file ../.env.production -f compose.prod.yaml up -d`. New and refreshed tokens are
   encrypted with `k2`; `k1` still decrypts older ones.
3. Watch the old key drain (Neon SQL editor):
   ```sql
   SELECT count(*) FROM "Session" WHERE "accessToken" LIKE 'enc:v1:k1:%';
   ```
   Offline tokens refresh regularly, so this falls to 0 over the following weeks.
4. When it is 0 (or after 90 days), remove `k1` and restart. Any shop still on `k1` is simply asked to
   re-authenticate the next time it opens the app; no sale data is lost.

If the key **leaked**: also rotate `SHOPIFY_API_SECRET` in the Partner Dashboard (and update the env file),
then follow SECURITY.md › "If the database is exposed".

## 12. Billing notes

- One plan, set by `PLAN_PRICE` and `TRIAL_DAYS` (defaults: $9.99 / 30 days, 7-day trial); keep the listing's
  Pricing section identical.
- Cancelling or pausing uses `prorate: true`: the merchant is credited for unused days, deducted from your
  payout. Owner decision (Oct 27, 2026), to avoid merchants losing paid days.
- Development stores (including App Store reviewers') always get test charges.

## Checklist

- [ ] Separate dev app linked; production `shopify.app.toml` has the real URLs and
      `automatically_update_urls_on_dev = false`
- [ ] Neon prod project; pooled `DATABASE_URL` + direct `DIRECT_URL`
- [ ] VM with reserved IP; ports 80/443 open in the security list **and** iptables; DNS `A` record
- [ ] Root `.env.production` (chmod 600); encryption key saved in a password manager
- [ ] `docker compose … up -d`; `/healthz` returns ok over https
- [ ] `npm run deploy` run; app installs on a dev store; live test plan passed
- [ ] Uptime monitor on `/healthz`; nightly backup cron + off-VM copy; restore tested once

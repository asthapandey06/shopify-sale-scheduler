# # PriceTide — Shopify app — Shopify app

Schedule sales on products or collections. At the start time the app lowers prices (and sets an honest
compare-at "was" price); at the end time it puts every price back exactly as it was. Built on Shopify's
official React Router app template (Node.js + TypeScript, Polaris web components, App Bridge, Prisma).

## What merchants get

- Percentage-off or fixed-amount-off sales on up to 250 products or 5 collections (5,000 variants per sale)
- Optional .99 / .95 / whole-number price endings
- Start now or schedule up to a year ahead; sales run 5 minutes to 90 days
- Exact restore of original price **and** compare-at price, to the cent
- Prices a merchant edits during a sale are never overwritten (flagged as "Edited during sale")
- Variants already in another running sale are skipped, so discounts never stack
- End early, cancel, restore after a failure, per-variant status table
- Shopify Billing: one "Pro" plan, $9.99 / 30 days, 7-day free trial (configurable)

## How it works

```
Merchant ──► Embedded admin UI (React Router + Polaris)
                │  session-token auth, validation, rate limit
                ▼
            PostgreSQL ◄──── Scheduler (in-process, every 30s, or POST /jobs/tick)
   Sale / SaleItem snapshot          │ per-shop lease (multi-instance safe)
                                     ▼
                         Shopify Admin GraphQL (productVariantsBulkUpdate)
```

1. **Snapshot first.** When a sale starts, every variant's current price and compare-at price are saved to
   the database *before* anything changes in Shopify. A crash at any point can always be reverted.
2. **Apply.** Prices are written per product in batches, with throttle-aware retries.
3. **Revert.** At the end time each variant is restored only if its price is still the sale price.
4. **Retries.** Failed starts retry with backoff (5 attempts); if some prices already changed, the sale
   rolls back automatically. Reverts never give up.

The core logic lives in `app/lib/` with no framework dependencies and is covered by tests in `test/`.

## Security

| Area | Measure |
| --- | --- |
| Authentication | Every admin route uses `authenticate.admin` (App Bridge session tokens, no cookies → no CSRF surface). OAuth handled by the official library with expiring offline tokens. |
| Webhooks | All webhooks verified by HMAC via `authenticate.webhook`; handlers are idempotent. |
| Tenant isolation | The shop always comes from the verified session, never from the request. Every query is scoped by shop; route ids are format-checked. |
| Secrets at rest | Shopify access and refresh tokens are encrypted with AES-256-GCM (random IV, auth tag, row-bound associated data) and support key rotation. |
| Least privilege | Only `write_products` scope. No customer, order or PII access. Boot fails if extra scopes are configured. |
| Input validation | Strict allow-list validation, size limits, GID format checks, control/bidi character stripping, 64 KB body cap. |
| Abuse limits | Per-shop rate limit on mutations, max 20 open sales per shop, max variants per sale. |
| Headers | Per-shop `frame-ancestors` CSP (library), HSTS, nosniff, Referrer-Policy, Permissions-Policy. |
| Errors & logs | Generic client errors; structured JSON logs with automatic redaction of tokens/secrets. |
| Cron endpoint | Disabled unless `CRON_SECRET` is set; POST only, constant-time bearer check, rate limited. |
| Privacy (GDPR) | Mandatory `customers/data_request`, `customers/redact`, `shop/redact` webhooks. `shop/redact` deletes all shop data. |
| Concurrency | Database lease per shop so multiple instances never change the same shop's prices at once. |
| Supply chain | Lockfile committed, `npm audit` in CI, Dependabot, non-root Docker image. |
| Config | Environment validated at boot (HTTPS app URL in production, key length, limits). |

See `SECURITY.md` for operational details (key rotation, incident steps).

## Local development

Prerequisites: Node 22.18+, [Shopify CLI](https://shopify.dev/docs/apps/tools/cli), a Partner account with a
development store, and PostgreSQL (Docker is easiest).

```bash
# 1. Database
docker run -d --name sale-scheduler-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pricetide -p 5432:5432 postgres:16

# 2. Install (this creates package-lock.json — commit it)
npm install

# 3. Environment
cp .env.example .env
#   set DATABASE_URL, and generate an encryption key:
node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"
#   paste it as TOKEN_ENCRYPTION_KEYS=k1:...

# 4. Verify everything compiles and the tests pass
npm run typecheck
npm test

# 5. Link to your app in the Partner Dashboard and run
npm run config:link
npm run dev
```

`npm run dev` applies migrations, starts a tunnel and opens the app in your development store. Charges are
always test charges on development stores.

### Local development with Docker (app + database)

`compose.yaml` runs the app (with the Shopify CLI, from `Dockerfile.dev`) and PostgreSQL 16. It is for
development only; production uses `Dockerfile`. Your code is mounted into the container, so edits hot-reload.

```bash
# 1. Environment: cp .env.example .env and set TOKEN_ENCRYPTION_KEYS as above.
#    Set DATABASE_URL=postgresql://postgres:postgres@db:5432/pricetide so the app and Prisma both use the
#    Docker database (compose also forces this value inside the container).

# 2. Start the database (data is kept in ~/.pricetide-dev/pgdata, which survives Cloud Shell restarts)
docker compose up -d db

# 3. Run the app. The first run installs dependencies; the Shopify CLI asks you to log in with a code
#    the first time (the login is kept in a Docker volume). Link your app once, then start dev.
docker compose run --rm app npm run config:link
docker compose run --rm app npm run dev

# Other commands run the same way, e.g.
docker compose run --rm app npm run check
docker compose run --rm app npx prisma migrate dev --name <change>

# Stop everything
docker compose down
```

The database is also published on `127.0.0.1:5432` for tools on the host. Dependencies are reinstalled
automatically when `package-lock.json` changes. On Cloud Shell, Docker volumes (installed dependencies and the
Shopify CLI login) are cleared when the VM is recycled; the next run reinstalls and asks you to log in again.
`docker compose down` keeps the database; delete `~/.pricetide-dev/pgdata` to reset it.

## Deploying to production

Any host that runs a Docker container and a PostgreSQL database works (Fly.io, Render, Railway, a VPS).

1. Create a managed PostgreSQL database.
2. Set environment variables (see `.env.example`): `NODE_ENV=production`, `SHOPIFY_API_KEY`,
   `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL` (https), `SCOPES=write_products`, `DATABASE_URL`,
   `TOKEN_ENCRYPTION_KEYS`, `SUPPORT_EMAIL`, `APP_OWNER_NAME`. Keep `BILLING_TEST_MODE` unset/false.
3. Build and run the `Dockerfile`. On start it runs `prisma migrate deploy`, then serves on port 3000.
   Health check: `GET /healthz`.
4. Point the app URL at it and push the config: `npm run deploy`.
5. Serverless host? Set `SCHEDULER_ENABLED=false`, set `CRON_SECRET`, and call every minute:
   `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://your-app/jobs/tick`

Run at least one always-on instance (or the cron) — sales only start and end while the scheduler runs.

## Before you submit to the App Store

The full requirement-by-requirement audit, listing copy, reviewer instructions and screencast script are in
`APP_STORE_SUBMISSION.md`. Privacy policy URL for the listing: `https://<your-app-url>/privacy`.

Test on a development store (with a few products, one with several variants and one with a compare-at price):

- [ ] Install, approve the free trial, create a "start immediately" sale → prices drop within ~30 s
- [ ] Check a variant in Shopify admin: sale price + compare-at shown correctly
- [ ] End the sale early → original prices and compare-at prices restored (including ones that had none)
- [ ] Edit one variant's price during a sale → after the end it keeps your edit, marked "Edited during sale"
- [ ] Schedule a sale 10 minutes ahead → starts on time; cancel another scheduled sale → no change
- [ ] Collection sale, a fixed-amount sale, and a .99 rounding sale
- [ ] Cancel the subscription → "Create sale" redirects to the plan page
- [ ] Uninstall and reinstall → no errors; failed sales offer "Restore original prices"

Submission: privacy policy URL, app listing with screenshots, a short screencast, test instructions for the
reviewer, and the $19 registration fee. Expect review to take a few weeks; use the time to recruit pilot
merchants.

## Known limitations

- Changes the store's base prices. Fixed prices set in Markets price lists or B2B catalogs are not changed
  (market prices calculated from the base price follow automatically).
- If the app is uninstalled while a sale is running, Shopify revokes access and prices can't be restored
  until it is reinstalled (the UI warns about this; reinstalling offers a one-click restore).
- Products with more than 5,000 variants in one sale need to be split (configurable).

## Project layout

```
app/lib/            Framework-free core: pricing, money math, sale engine, crypto, validation, logging
app/services/       Prisma repo, Shopify GraphQL gateway, scheduler, encrypted session storage
app/routes/         Admin pages (sales list, create, detail, plan), webhooks, /jobs/tick, /healthz
prisma/             PostgreSQL schema and migrations
test/               Node test runner suites (no network or database needed)
```

Licensed under MIT (template © Shopify, see LICENSE.md).

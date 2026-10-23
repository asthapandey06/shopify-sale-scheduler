# AGENTS.md — PriceTide (Shopify app)

Instructions for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this repository.
Read this whole file before making changes.

## What this app is

**PriceTide: Scheduled Sales** — an embedded Shopify app (public App Store app, paid subscription).
Merchants pick products or collections, a discount (percent or fixed amount, optional .99/.95/whole
rounding) and a start/end time. At the start the app lowers variant prices and sets a compare-at
("was") price; at the end it restores the exact original price and compare-at price.

- Owner: Astha P. Shukla (GitHub `asthapandey06`), repo `shopify-sale-scheduler`.
- Status: pre-launch. Goal is to pass Shopify App Store review. See `APP_STORE_SUBMISSION.md`.
- Rename in progress: user-facing name is **PriceTide**. Internal identifiers (`sale-scheduler`,
  `sale_scheduler`, GraphQL operation names `SaleScheduler…`) may stay as they are.

## Stack

- Node.js **22.18+**, TypeScript (strict), ESM (`"type": "module"`).
- Shopify official React Router template: `@shopify/shopify-app-react-router`, App Bridge,
  Polaris **web components** (`<s-page>`, `<s-button>`, …) — not Polaris React.
- Shopify **Admin GraphQL API only** (version `2026-10`). Never use the REST Admin API (App Store req 2.2.4).
- Prisma + **PostgreSQL** (dev: Neon free tier; never SQLite).
- Tests: Node's built-in test runner (`node --test`), no Jest/Vitest.

## Commands

```bash
npm install                 # install deps (commit package-lock.json)
npx prisma generate         # after any schema change or fresh install
npm run typecheck           # react-router typegen + tsc --noEmit
npm test                    # node --test "test/**/*.test.ts"
npm run lint
npm run check               # typecheck + test + lint — run before every commit
npm run dev                 # shopify app dev (migrations + tunnel + dev store)
npx prisma migrate dev --name <change>   # create a migration after editing schema.prisma
```

Definition of done for any change: `npm run check` passes, and new logic has tests.

## Project layout

```
app/lib/        Framework-free core. No Shopify/Prisma/React imports here. Imports use ".ts" extensions
                so tests run directly under Node.
  money.ts        Exact decimal money math (BigInt). Never use floats for prices.
  pricing.ts      Sale price calculation and rounding.
  sale-engine.ts  Apply/revert state machine, retries, rollback, per-shop lease.
  sale-types.ts   Statuses, records, SaleRepo + AdminGateway interfaces.
  memory-repo.ts  In-memory SaleRepo used by tests (must mirror Prisma repo semantics).
  crypto.ts       AES-256-GCM token encryption with key rotation.
  validation.ts   Allow-list input validation for all client input.
  env.ts          Config validation at boot (fails fast with all errors).
  logger.ts       JSON logger with secret redaction.
  rate-limit.ts, security-headers.ts
app/services/   Server adapters: Prisma repo, Shopify GraphQL gateway, scheduler worker,
                encrypted session storage, billing/shop helpers. Files end in `.server.ts`.
app/routes/     React Router flat routes: admin pages (app.*), webhooks.*, jobs.tick, healthz, privacy.
app/components/ Shared UI (status badges, local time, error page).
prisma/         schema.prisma + migrations (PostgreSQL).
test/           *.test.ts suites + helpers (fake Shopify store, clock).
```

## Non-negotiable rules

### Money and prices
- All price math goes through `app/lib/money.ts` / `pricing.ts`. No `Number`/`parseFloat` arithmetic on prices.
- Respect currency decimals (JPY = 0, KWD = 3, default 2).
- A sale price must be > 0 and < the current price, otherwise the variant is SKIPPED.

### Sale engine safety invariants (do not weaken; add tests if you touch the engine)
1. **Snapshot before write**: original price + compare-at are saved to the DB *before* any Shopify write.
2. **Idempotent and resumable**: re-running a step writes the same values; a crash at any point can be reverted.
3. **Merchant edits win**: on revert, only restore a variant whose live price still equals the sale price;
   otherwise mark it CONFLICT and leave it alone.
4. **No stacking**: a variant already PENDING/APPLIED in another live sale is SKIPPED.
5. **One worker per shop**: all price writes happen under the per-shop DB lease (`claimShop`/`renewShop`/`releaseShop`).
6. **Reverts never give up**; failed activations that already changed prices roll back automatically.
7. Ending a sale must work even if billing has lapsed.

### Security
- Every admin loader/action calls `authenticate.admin(request)`. The **shop always comes from the session**,
  never from request params/body. Every DB query is scoped by `shop`.
- Every webhook route calls `authenticate.webhook(request)` (HMAC) and is idempotent.
- Validate all client input through `app/lib/validation.ts` (allow-lists, length/size limits, GID format).
- Never log tokens, sessions, request bodies or secrets. Use `logger` (it redacts), not `console.log`.
- Access/refresh tokens are encrypted at rest via `EncryptedSessionStorage`; don't bypass it.
- Access scopes: **`write_products` only**. Do not add scopes without explicit approval from the owner.
- Return generic errors to the client (`toErrorResponse`); details go to server logs only.
- Never commit `.env`, keys, tokens or `graphify-out/`.

### Shopify App Store requirements (must keep passing)
- Billing only via Shopify Billing API; plan page reachable; works on accept/decline/reinstall.
- No "enter your shop domain" form (installs start from Shopify).
- Embedded app uses session tokens; no cookies/localStorage for auth.
- Mandatory privacy webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) stay registered
  in `shopify.app.toml` and working; `shop/redact` deletes all shop data.
- No raw 404/500 pages: use the error boundaries / `ErrorPage`.
- Dev stores always get test charges (`isTestBillingShop` / `refreshDevStoreFlag`).

### UI
- Use Polaris web components (`s-*`) and App Bridge (`useAppBridge`: toast, resourcePicker).
- No native `window.confirm`/`alert` (unreliable in the admin iframe) — use inline confirmation banners.
- Show times in the merchant's local time zone (`LocalTime`); send ISO strings with a timezone to the server.

## Database changes
- Edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <change>`; commit the migration folder.
- Never edit an already-applied migration. Keep `Session` table fields compatible with
  `@shopify/shopify-app-session-storage-prisma`.
- If you change repo semantics, update both `app/services/sale-repo.server.ts` and `app/lib/memory-repo.ts`.

## Testing
- Engine, pricing, validation, crypto and gateway logic are unit-tested without network or DB.
- Use `test/helpers.ts` (`createFakeStore`, `clock`) for engine scenarios; don't hit real Shopify in tests.
- Add a regression test for every bug fix.

## Codebase map (Graphify)
- If `graphify-out/GRAPH_REPORT.md` exists, read it first for structural questions
  (what calls what, where a feature lives) before opening many files.
- The graph is a map, not the source of truth: always read the actual file before editing it.
- After significant changes run `graphify . --update` (not a full rebuild). Never point Graphify at `.env*`.

## Development environment
- Development happens in **Google Cloud Shell** (repo at `~/node/sale-scheduler`), opened from desktop
  VS Code over SSH. Only `$HOME` persists (5 GB limit) — keep caches small (`npm cache clean --force`).
- Node via `nvm` (default 22). Database: Neon Postgres (direct connection string in `.env`).
- `npm run dev` uses the Shopify CLI tunnel; no port forwarding needed.

## Git workflow
- Small, focused commits with clear messages. Run `npm run check` before committing.
- Don't push to `main` with failing checks. Don't rewrite published history.
- Dependabot is limited to monthly minor/patch groups; don't merge major upgrades without testing.
- `react-router` / `@react-router/*` are pinned at 7.18.2 (template requirement) — don't bump them.

## Ask before you…
- Add or change access scopes, billing plans/prices, or webhook subscriptions.
- Add a new dependency (prefer the standard library and existing utilities).
- Change the sale engine's status transitions or the database schema.
- Delete data, migrations, or anything outside this repository.

## Known limitations (don't "fix" silently)
- Only base variant prices change; Markets/B2B fixed price lists are untouched.
- If the app is uninstalled mid-sale, prices can't be restored until reinstall (UI warns; reinstall offers restore).
- Max 5,000 variants per sale, 20 open sales per shop (configurable via env).
# PriceTide runbook

What to do when something goes wrong in production. Setup and releases are in `DEPLOY.md`; security
incidents in `SECURITY.md`.

**Golden rules**
- Prices are merchants' money. Never edit `Sale`/`SaleItem` rows or Shopify prices by hand unless a step
  below says so, and always filter by `shop`.
- Every price write happens under the per-shop lease; restarting the app is always safe (the scheduler
  finishes its pass, and a crashed worker's lease expires after 5 minutes).
- Reverts never give up: a sale in `REVERTING` keeps retrying (backoff up to 30 minutes) until every
  variant is restored or recorded as left alone.

## Where to look

**Logs** (JSON lines, secrets redacted; on the VM in `/opt/pricetide/deploy`):
```bash
docker compose --env-file ../.env.production -f compose.prod.yaml logs --since 24h app | grep '"shop":"<store>.myshopify.com"'
docker compose --env-file ../.env.production -f compose.prod.yaml logs --since 2h app | grep -E '"level":"(warn|error)"'
# pretty-print with jq (sudo apt-get install jq):
docker compose --env-file ../.env.production -f compose.prod.yaml logs --no-log-prefix --since 24h app | jq -R 'fromjson? | select(.shop=="<store>.myshopify.com")'
```

| Log message | Meaning |
|---|---|
| `PriceTide scheduler started` / `Scheduler stopped` | Container start / graceful stop |
| `Scheduler pass finished` | A pass did work (`processed`, `skippedLocked`, `errors`); idle passes are silent |
| `Scheduler pass failed` | The whole pass failed (usually the database); retried next interval |
| `Sale activated` / `Sale activation will retry` / `Sale activation failed` | Start succeeded / transient error, backing off / gave up (rolled back or failed) |
| `Sale reverted` | Sale ended; `restored` = prices put back, `conflicts` = merchant-edited prices left alone |
| `Sale revert failed; will retry` | Restore incomplete; retried automatically |
| `Shopify API throttled, backing off` | Normal under load; retried |
| `Lost shop lease; stopping work on this shop` | Another worker took over (only with 2+ instances or a very slow pass) |
| `Sale status changed concurrently; leaving it as is` | A cancel/uninstall/pause won a race; expected and safe |
| `Merchant action` | Merchant did something (`action`: sale.created, sale.cancelled, sale.ended_early, shop.paused, …) |
| `Webhook received` | Shopify webhook processed (`topic`, `webhookId`) |
| `Ignoring app/uninstalled…` / `Skipping shop/redact…` | Late webhook after a reinstall; data kept on purpose |
| `Could not decrypt stored session; forcing re-authentication` | Token key missing/rotated wrong (see "Encryption key" below) |
| `Unhandled server error` / `Unhandled error in request` | Bug or outage in a page/action: check `path` and `error` |

**Database** (Neon console › SQL editor; read-only queries unless a step says otherwise):
```sql
-- A shop's sales, newest first
SELECT id, name, status, "startsAt", "endsAt", attempts, "nextAttemptAt", "lastError"
FROM "Sale" WHERE shop = '<store>.myshopify.com' ORDER BY "startsAt" DESC LIMIT 20;

-- Variant outcome counts for one sale
SELECT status, count(*) FROM "SaleItem" WHERE "saleId" = '<sale id>' GROUP BY status;

-- What happened to a sale, in order
SELECT "createdAt", action, detail FROM "AuditLog"
WHERE shop = '<store>.myshopify.com' AND "saleId" = '<sale id>' ORDER BY "createdAt";

-- The shop's state: plan, pause, uninstall, scheduler lease
SELECT shop, "billingActive", "isDevStore", "pausedAt", "installedAt", "uninstalledAt", "lockOwner", "lockedUntil"
FROM "Shop" WHERE shop = '<store>.myshopify.com';
```

Merchants see the same status per variant on the sale's page in the app, which is often the fastest way to
explain what happened.

---

## 1. A sale didn't start (FAILED, or stuck in "Starting…")

1. Look up the sale (query above) and read `lastError`, `attempts`, `nextAttemptAt`.
2. Match the cause:

| `lastError` / state | Cause | Fix |
|---|---|---|
| "The shop has no active subscription…" | Plan cancelled, declined or frozen | Merchant approves the plan on the Plan page, then creates the sale again (a FAILED sale doesn't restart) |
| "The sale window passed before it could start (PriceTide was paused, offline or unreachable)" | Scheduler wasn't running at start time, or the shop was paused | Section 4 if the scheduler was down; merchant creates a new sale |
| "…more than N variants…" / "…have no variants." | Too many variants (`MAX_VARIANTS_PER_SALE`) or empty selection | Merchant splits the sale / picks other products |
| `ACTIVATING`, `attempts` 1–4, future `nextAttemptAt` | Transient Shopify error; backing off (1, 2, 4, 8 min…) | Wait. Logs: `Sale activation will retry` with the error |
| "Could not finish starting the sale, rolling back: …" | Gave up after 5 attempts with some prices already changed | Nothing: it moves to `REVERTING` and restores them. Check it reaches `COMPLETED` |
| "PriceTide was paused while this sale was starting…" | Merchant paused mid-start | Expected; prices are being restored |
| `SCHEDULED` long after `startsAt`, no error | Shop is paused (`Shop.pausedAt` set) or the scheduler is down | Paused: merchant resumes on the Plan page. Otherwise section 4 |

3. Per-variant problems (sale is running but some variants weren't changed): the item list shows
   `SKIPPED` with a reason (price is zero, discount doesn't lower the price, already discounted by another
   sale) or `FAILED` with Shopify's message. These are by design; nothing to repair.

## 2. A sale isn't restoring prices (stuck in "Restoring prices…")

1. Look up the sale: `status = 'REVERTING'`, read `lastError` and `attempts`; count items still `APPLIED`.
2. Causes and fixes:
   - **Shopify errors or throttling** ("Restoring prices, will retry: …"): it retries with backoff (max 30 min).
     To retry now (safe: the engine re-checks live prices before writing):
     ```sql
     UPDATE "Sale" SET "nextAttemptAt" = NULL
     WHERE id = '<sale id>' AND shop = '<store>.myshopify.com' AND status = 'REVERTING';
     ```
   - **App uninstalled mid-sale**: the sale is `FAILED` with "The app was uninstalled while this sale was
     running…"; Shopify revoked access, so nothing can be restored until the merchant **reinstalls** and
     clicks **Restore original prices** on that sale. Variants it still holds are protected from other sales.
     This only works if they reinstall within 48 hours: after that `shop/redact` erases the snapshot (the logs
     then show `Purging a shop whose sale prices were never restored` if the 30-day purge did it). Without
     the snapshot, the merchant has to reset those prices by hand in the Shopify admin.
   - **Scheduler not running**: section 4.
3. After it completes, `Sale reverted` logs `restored` and `conflicts`. Conflicts are prices the merchant
   changed during the sale; they were left as the merchant set them, on purpose.

## 3. A merchant reports wrong prices

1. Get the store domain and the product/variant (the variant id is the number in the admin URL:
   `…/variants/<number>` → `gid://shopify/ProductVariant/<number>`).
2. Find every sale that touched it:
   ```sql
   SELECT i."saleId", s.name, s.status AS sale_status, i.status AS item_status, i."originalPrice",
          i."originalCompareAtPrice", i."salePrice", i."saleCompareAtPrice", i.message, i."updatedAt"
   FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
   WHERE i.shop = '<store>.myshopify.com' AND i."variantId" = 'gid://shopify/ProductVariant/<number>'
   ORDER BY i."updatedAt" DESC;
   ```
3. Read the item status:
   - `APPLIED` in an `ACTIVE` sale → the sale price is expected until `endsAt`.
   - `APPLIED` in a `FAILED` sale → prices still changed (e.g. uninstalled mid-sale): merchant clicks
     **Restore original prices** on that sale.
   - `CONFLICT` → the price was edited during the sale, so PriceTide left it alone. If the merchant wants
     the original back, they set `originalPrice` / `originalCompareAtPrice` themselves in the Shopify admin.
   - `REVERTED` → restored to `originalPrice` / `originalCompareAtPrice`. If the price is different now,
     something else changed it afterwards (another app, an import, a staff member): check the product's
     history in the Shopify admin.
   - `SKIPPED` → never changed (see `message`).
   - No rows → PriceTide never touched this variant.
4. Known limitation: only the base variant price changes. Fixed prices in Markets price lists or B2B
   catalogs are not touched, so those can look "wrong" during a sale.
5. If the data shows a PriceTide bug, give the merchant the exact original prices from the query, open an
   issue with the sale id (no tokens or personal data), and add a regression test with the fix.

## 4. The scheduler stopped (sales don't start or end)

1. Is the app up? `curl -s https://<app domain>/healthz` and `docker compose --env-file ../.env.production -f compose.prod.yaml ps`
   (should be `healthy`). If down: `docker compose --env-file ../.env.production -f compose.prod.yaml up -d` and read the logs; a config
   error lists every problem at boot.
2. Overdue work (anything here more than a few minutes old means the scheduler isn't keeping up):
   ```sql
   SELECT id, shop, status, "startsAt", "endsAt", "nextAttemptAt" FROM "Sale"
   WHERE ("status" = 'SCHEDULED' AND "startsAt" < now() - interval '5 minutes')
      OR ("status" = 'ACTIVE' AND "endsAt" < now() - interval '5 minutes')
   ORDER BY "startsAt" LIMIT 50;
   ```
   (Scheduled sales of paused shops are expected here; check `Shop.pausedAt`.)
3. Logs: look for `Scheduler pass failed` (usually the database: section 5) and for
   `"skippedLocked"` that keeps growing for one shop.
4. A stale lease: `Shop.lockedUntil` in the past is free to take; a live one belongs to a running pass. Leases
   are 5 minutes and renewed during work. Only if a lease points at a container that no longer exists and is
   far in the future (shouldn't happen), clear it:
   ```sql
   UPDATE "Shop" SET "lockOwner" = NULL, "lockedUntil" = NULL WHERE shop = '<store>.myshopify.com';
   ```
5. `SCHEDULER_ENABLED` must be true (default) on the VM; with `false` nothing runs sales except
   `POST /jobs/tick`.
6. Restart: `docker compose --env-file ../.env.production -f compose.prod.yaml restart app` (safe at any time). Overdue starts run on the
   next pass; sales whose end time already passed are restored; a sale whose whole window passed is marked
   FAILED ("window passed") rather than started late.

## 5. The database is down

Symptoms: `/healthz` returns 503 `{"ok":false}`, the uptime monitor alerts, logs show `Scheduler pass failed`
and `Unhandled server error` with Prisma connection errors; merchants see "Something went wrong".

1. Check Neon: console (project › Monitoring) and https://neonstatus.com. Free-plan computes scale to zero:
   the first connection after idle takes a few seconds (`connect_timeout=15` covers it).
2. Check limits: compute hours / storage on your plan, and the pooler's connection limit.
3. Check credentials: a reset password or rotated role means updating `DATABASE_URL` and `DIRECT_URL` in
   the root `.env.production`, then `docker compose --env-file ../.env.production -f compose.prod.yaml up -d`.
4. While it's down: no prices change (nothing can be written without the database first), webhooks fail and
   Shopify retries them, merchants can't open the app. When it's back, everything resumes on the next
   pass: overdue sales start or end, reverts continue.
5. Data loss or corruption: restore the latest Neon point-in-time or `before-<tag>` branch (DEPLOY.md ›
   Backups), point `DATABASE_URL`/`DIRECT_URL` at it, restart. Sales that changed prices after the restore
   point have no record: compare live prices with the last nightly dump before restarting the scheduler
   (`SCHEDULER_ENABLED=false` while you check).

## 6. Other incidents

- **Webhooks rejected (401) / logins failing after a secret change**: `SHOPIFY_API_SECRET` in
  `.env.production` must match the Partner Dashboard; restart after changing it.
- **`Could not decrypt stored session`**: the key used for those tokens isn't in `TOKEN_ENCRYPTION_KEYS`
  (lost or removed too early). Put the old key back (second position) if you have it; otherwise those shops
  re-authenticate automatically on next open. No sale data is affected.
- **HTTPS certificate errors**: `docker compose --env-file ../.env.production -f compose.prod.yaml logs caddy`; ports 80/443 must be open
  (security list + iptables) and DNS must point at the VM.
- **Disk full on the VM**: `docker system df`; remove old images you no longer need for rollback with
  `docker image rm pricetide:<old tag>`, and old dumps in `/var/backups/pricetide`.
- **Privacy requests**: `customers/*` webhooks need no action (no customer data is stored). A store asking
  for its data: export its rows with the queries above; asking for deletion: the merchant can use
  "Permanently delete my data" on the Plan page, or `shop/redact` erases everything 48 hours after uninstall
  (30 days at the latest).

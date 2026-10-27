---
description: Safe procedure for changing how sales are applied, reverted, priced or scheduled in PriceTide (app/lib/sale-engine.ts, pricing.ts, money.ts, sale-repo, memory-repo, scheduler, Shopify gateway). Use whenever a task touches discounts, rounding, price restore, sale statuses, retries, locking, or the background scheduler.
---

# Changing the sale engine

Merchant prices are real money. A bug here can leave a store with wrong prices, so follow this exactly.

## Before editing

1. Read `app/lib/sale-engine.ts`, `app/lib/sale-types.ts` and the related tests in `test/engine.test.ts`
   (and `test/pricing.test.ts` / `test/gateway.test.ts` if relevant).
2. Restate which of these invariants your change could affect:
   1. Snapshot original price + compare-at to the DB before any Shopify write.
   2. Every step is idempotent and resumable after a crash.
   3. On revert, restore only if the live price still equals the sale price; otherwise CONFLICT.
   4. A variant in another live sale is SKIPPED (no stacking).
   5. All price writes happen under the per-shop lease.
   6. Reverts never give up; failed activations roll back changed prices.
   7. Ending a sale works even if billing lapsed.
3. If the change alters status transitions or the DB schema, stop and ask the owner first.

## While editing

- Price math only via `app/lib/money.ts` (BigInt). No floats.
- Keep `app/lib/*` free of Shopify/Prisma/React imports; adapters live in `app/services/`.
- If repo behaviour changes, update **both** `app/services/sale-repo.server.ts` and
  `app/lib/memory-repo.ts` so tests reflect production.
- Shopify calls go through the `AdminGateway` interface (GraphQL only, throttle-aware).

## Tests (required)

- Write the failing test first in `test/engine.test.ts` using `createFakeStore` and `clock`
  from `test/helpers.ts`, then make it pass.
- Cover: the happy path, a crash/retry path, and the merchant-edit (CONFLICT) path if prices are written.
- Then run the `verify-change` skill (`npm run check`).

## Report

Summarize the behaviour change, which invariants were touched, and the tests that prove they still hold.

---
description: How to add or change a Shopify Admin GraphQL call in PriceTide safely (queries, mutations, pagination, userErrors, throttling, tests). Use when a task needs new Shopify data, a new mutation, a changed query, or mentions GraphQL, Admin API, products, variants, collections or billing API calls.
---

# Shopify Admin GraphQL changes

## Rules

- **GraphQL Admin API only**, version `2026-10` (set in `app/shopify.server.ts`). Never REST.
- Scope is `write_products` only. If the call needs another scope, **stop and ask the owner**.
- Verify field and argument names against current docs before writing — delegate to the
  `shopify-docs-researcher` subagent if unsure. Never guess field names.

## Where code goes

- Engine-facing calls: add a method to the `AdminGateway` interface in `app/lib/sale-types.ts` and implement it
  in `app/services/shopify-gateway.server.ts` using the existing `query()` helper (it handles THROTTLED retries).
- One-off route calls (e.g. loading shop currency for a page): `admin.graphql(...)` inside the route's loader/action,
  after `authenticate.admin`.

## Writing the operation

1. Prefix the operation name with `SaleScheduler` and tag it with `#graphql`, e.g.
   `query SaleSchedulerVariantPrices($ids: [ID!]!) { ... }`.
2. Always pass values as **variables** — never interpolate user input into the query string.
3. Request only the fields you use; keep page sizes ≤ 250 (≤ 100 for `nodes(ids:)`).
4. Paginate with `pageInfo { hasNextPage endCursor }` and stop early at caps.
5. Mutations: always read `userErrors { field message }`. Map per-item errors back to the item
   (see `updateVariantPrices` for the `field[1]` index pattern). Treat anything not confirmed as failed.
6. Handle deleted resources (`null` nodes / `product: null`) without throwing.

## Tests (required)

- Add cases to `test/gateway.test.ts` using the `fakeAdmin` pattern: success, pagination, `userErrors`,
  deleted resources, and throttling if relevant.
- If the engine uses the new method, extend `createFakeStore` in `test/helpers.ts` and add engine tests.
- Finish with the `verify-change` skill.

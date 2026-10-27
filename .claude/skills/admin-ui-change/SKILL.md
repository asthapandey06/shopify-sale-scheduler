---
description: Conventions for building or changing PriceTide's embedded admin pages (React Router routes, Polaris web components, App Bridge, loaders/actions, forms, errors). Use when adding a page, changing a screen, form, table, banner, navigation, or any UI text in app/routes or app/components.
---

# Admin UI changes

## Route pattern

- Files in `app/routes/app.*.tsx` (flat routes). Every loader and action starts with
  `const { session, ... } = await authenticate.admin(request)`; the shop comes from `session.shop` only.
- Validate input with `app/lib/validation.ts`; size-limit bodies (`readJsonBody`).
- Mutating actions call `enforceRateLimit(session.shop)` and wrap errors with `toErrorResponse` from
  `app/services/http.server.ts` (generic messages to the client).
- Redirect with the `redirect` helper returned by `authenticate.admin` (keeps embedded params), not React Router's.
- Export `headers` using `boundary.headers` like the existing routes.
- Pages that need a plan use `billing.require` (see `app.sales.new.tsx`).

## Components

- Use **Polaris web components** (`<s-page>`, `<s-section>`, `<s-button>`, `<s-banner>`, `<s-table>`,
  `<s-text-field>`, `<s-select>` …). Check props against shopify.dev before using an unfamiliar one
  (delegate to `shopify-docs-researcher` if unsure). Don't add Polaris React or other UI libraries.
- Page actions: one `slot="primary-action"` button (`variant="primary"`); others in `slot="secondary-actions"`.
- Tables: set `listSlot="primary"`/`"secondary"` on headers so mobile layout works.
- Feedback: `useAppBridge().toast.show(...)`; pickers: `shopify.resourcePicker(...)`.
- **No `window.confirm`/`alert`** — use an inline confirmation `<s-banner>` (see `app.sales.$id.tsx`).
- Times: render with `LocalTime`; send ISO strings with a timezone to the server.
- Money: format with `formatMoney`; never compute prices in the UI except previews via `computeSalePrice`.

## Copy

- Plain, short, merchant-friendly text. User-facing name is **PriceTide**.
- No statistics, guarantees or superlatives (App Store listing rules carry over to in-app copy).

## Finish

- Run `verify-change`. If the Playwright MCP is available and the page is public, run `ui-smoke-test`.

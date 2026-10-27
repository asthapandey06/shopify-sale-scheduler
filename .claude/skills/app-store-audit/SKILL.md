---
description: Audits PriceTide against the Shopify App Store requirements and the checklist in APP_STORE_SUBMISSION.md, reports pass/fail per requirement with file evidence, and lists remaining manual tasks. Use before submitting to Shopify, after big changes, or when the user asks "will this pass review", "check App Store requirements", or "audit the app".
---

# App Store audit

## Steps

1. Read `APP_STORE_SUBMISSION.md` and `AGENTS.md` (App Store section).
2. Verify each item in the code, citing the file that proves it:
   - **Auth**: every `app/routes/app*.tsx` loader/action calls `authenticate.admin`; no cookie or
     localStorage auth; no shop-domain input form anywhere (req 1.1.1, 2.3.1).
   - **Billing**: plan defined in `app/shopify.server.ts`; plan page works for subscribe/cancel;
     merchants without a plan reach the plan page; dev stores use test charges (1.2.x).
   - **GraphQL only**: no REST Admin calls (2.2.4). Search for `rest`, `/admin/api/`.
   - **Scopes**: `shopify.app.toml` and `SCOPES` are exactly `write_products` (3.2).
   - **Webhooks**: `app/uninstalled`, `app_subscriptions/update`, and the three compliance topics are
     declared in `shopify.app.toml` and each route calls `authenticate.webhook` (privacy).
   - **Errors**: error boundaries render `ErrorPage`; no raw 404/500 (2.1.3).
   - **Privacy page**: `app/routes/privacy.tsx` exists and is public.
   - **Name**: user-facing name is consistent (`shopify.app.toml` `name`, landing page, privacy page) (4.1.1).
3. Run the `verify-change` skill — a build or test failure is an automatic fail (2.1.1).
4. If the Playwright MCP is available, run the `ui-smoke-test` skill for public pages.

## Output

A table: Requirement | Status (Pass / Fail / Manual) | Evidence (file:line or reason).
Then a short list of fixes needed in code (offer to make them) and manual tasks for the owner
(listing copy, screenshots, screencast, live dev-store test, $19 registration, emergency contact).
Do not claim the app "will pass" — reviewers test the live app by hand.

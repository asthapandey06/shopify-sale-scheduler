# App Store submission kit

Audit of this codebase against the Shopify App Store requirements
(https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), checked October 21, 2026;
re-audited October 27, 2026 (API fields, billing, webhooks and Polaris props re-checked against shopify.dev).

Legend: ✅ met in code · 🔧 fixed during this audit · 🟡 you must do it (listing / dashboard / live test) · ⛔ blocker

## 1. Requirement audit

### Policy

| Req | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1.1.1 | Session tokens, no third-party cookies or local storage | ✅ | `authenticate.admin` (App Bridge session tokens) on every admin route; no `localStorage`/cookies used anywhere in `app/` |
| 1.1.2–1.1.16 | Checkout, themes, payments, shipping, lending, etc. | ✅ n/a | App only edits product variant prices; touches no checkout, theme, shipping, payment or order flows |
| 1.1.4 | Only factual information | ✅ | Compare-at price is the real previous price (or the existing higher compare-at); no fake urgency or data |
| 1.2.1 | Bill through Shopify | ✅ | Shopify Billing API, `app/shopify.server.ts` (`billing` config), `app/routes/app.billing.tsx` |
| 1.2.2 | Billing works on accept, decline and reinstall | 🔧 | Merchants without a plan are sent to the plan page on install and reinstall (`app._index.tsx`); decline returns them to it. Test vs real charge decided per store (`shop-plan.server.ts`) so reviewer dev stores never get a real charge |
| 1.2.3 | Plan changes without support | ✅ | Single plan; subscribe and cancel are self-serve on the Plan page. Re-check if you add tiers: upgrade/downgrade must work in-app |
| 1.3.1 | No review incentives | ✅ | App never asks for reviews |

### Functionality

| Req | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 2.1.1–2.1.2 | No critical or minor errors | 🟡 | Run the live test plan in section 4 on a dev store. Code paths covered by 72 unit tests and 16 PostgreSQL integration tests (`npm test`, `npm run test:db`) |
| 2.1.3 | Usable UI, no raw 404/500 pages | 🔧 | Friendly error pages added (`components/error-page.tsx`, error boundaries in `root.tsx` and `routes/app.tsx`) |
| 2.1.4 | Data synchronized accurately | ✅ | Snapshot-before-change, exact decimal math, conflict-safe revert, never-give-up restore (`lib/sale-engine.ts`) |
| 2.2.1 | Uses Shopify APIs | ✅ | Admin GraphQL |
| 2.2.2 | Consistent embedded experience | ✅ | Everything runs inside the Shopify admin (embedded = true) |
| 2.2.3 | Latest App Bridge | ✅ | Loaded from Shopify CDN by `AppProvider` (official template) |
| 2.2.4 | GraphQL Admin API only | ✅ | No REST calls; API version 2026-10 |
| 2.2.5–2.2.9 | Admin / Sidekick extensions | ✅ n/a | No extensions |
| 2.3.1 | Install only from Shopify surfaces, never ask for a shop domain | 🔧 | No shop-domain form anywhere: removed from the landing page and from `/auth/login` (now tells visitors to open the app from Shopify); `test/app-store.test.ts` fails if one comes back |
| 2.3.2 / 2.3.4 | OAuth immediately on install and reinstall | ✅ | Shopify-managed installation (scopes in `shopify.app.toml`) + `authenticate.admin` |
| 2.3.3 | Land in app UI after install | ✅ | Managed install redirects to the embedded app |

### Security

| Req | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 3.1.1 | Valid TLS | 🟡 | Boot refuses a non-https `SHOPIFY_APP_URL` in production; your host must serve a valid certificate |
| 3.2.x | Only necessary scopes | ✅ | Only `write_products`; boot fails if extra scopes are configured |
| Mandatory compliance webhooks | `customers/data_request`, `customers/redact`, `shop/redact`, 401 on bad HMAC | ✅ | Declared in `shopify.app.toml`; handlers in `app/routes/webhooks.*`; HMAC verified by the library (invalid → 401) |
| Clickjacking protection | Frame only inside the shop's admin | ✅ | Per-shop `frame-ancestors` CSP via `addDocumentResponseHeaders`; public pages (`/`, `/privacy`, `/auth/login`) send `frame-ancestors 'none'` |

### Listing (you complete these in the Partner Dashboard)

| Req | Requirement | Status | What to do |
| --- | --- | --- | --- |
| 4.1.1 | Same name in dashboard and listing | 🟡 | Use one name everywhere, including `name` in `shopify.app.toml` |
| 4.1.2 | Unique name | ✅ (confirm on save) | Owner searched apps.shopify.com for "PriceTide" on Oct 27, 2026: no app with that name in the results (similar names only: Pricefy, PricePirate, Pricewise, PriceIQ…). The Partner Dashboard rejects duplicate listing names when you save. Close competitors to position against: PriceGrid (bulk edit + sales that restore), Wi Flash Sale |
| 4.2.1–4.2.3 | Accurate pricing, only in the Pricing section, not in images | 🟡 | Use the pricing text in section 2; keep prices out of screenshots and description |
| 4.3.1 | Online Store requirement | 🟡 | Do **not** mark Online Store as required (the app works on any sales channel's base prices) |
| 4.3.2 | Languages | 🟡 | English only |
| 4.3.3–4.3.4 | No stats, guarantees or superlatives | 🟡 | Listing copy in section 2 avoids them; keep screenshots free of claims |
| 4.3.5 | Accurate tags | 🟡 | Suggested category: Marketing and conversion › Discounts / Pricing |
| 4.3.6–4.3.7 | No reviews/testimonials | 🟡 | None in copy |
| 4.4.x | Clear subtitle, real UI screenshots, no Shopify logo misuse | 🟡 | Capture screenshots from your dev store (list, create, detail, plan pages) |
| 4.5.3 | Demo screencast | 🟡 | Script in section 3 |
| 4.5.4–4.5.5 | Test credentials | 🟡 | No separate account needed; say so in testing instructions (section 3) |
| 4.5.6 | Emergency developer contact | 🟡 | Partner Dashboard › Settings |
| Privacy policy URL | Required on the listing | 🔧 | Public page added: `https://<your-app-url>/privacy` (set `SUPPORT_EMAIL` and `APP_OWNER_NAME`) |

### Category-specific (5.x)

All n/a: no theme changes, payments, subscriptions, sourcing, checkout, sales channel, post-purchase,
mobile builder, donation or blockchain features.

## 2. Listing copy (compliant draft)

Replace `PriceTide` with your new unique name.

**App card subtitle** (≤ 62 chars):
Schedule sales on products and collections with auto-restore

**App introduction:**
Plan a sale once and let it run on its own. PriceTide lowers prices at the start time and puts them back
when the sale ends, so you don't have to edit products by hand at midnight.

**App details:**
Choose products or whole collections, set a percentage or fixed amount off, and pick a start and end time.
When the sale starts, each variant gets its sale price and a compare-at price showing what it cost before.
When it ends, the original prices and compare-at prices are restored. If you change a price yourself during
a sale, your change is kept. You can end a sale early, cancel one before it starts, and see the status of
every variant.

**Key features:**
- Percentage or fixed-amount discounts with optional .99 or .95 price endings
- Products or collections, scheduled up to a year ahead
- Original prices and compare-at prices restored when the sale ends
- Prices you edit during a sale are left as you set them

**Pricing section:** Pro — $9.99 every 30 days, 7-day free trial. (Must match `PLAN_PRICE` and `TRIAL_DAYS`.)

**Name ideas to check for uniqueness:** Markdown Window, PriceTide, Sale Timer Pro, Clockwork Markdowns,
Tempo Sales. Search apps.shopify.com for each before choosing.

## 3. Reviewer testing instructions and screencast

**Testing instructions (paste into the submission form):**
> No external account or login is needed. After installing, approve the test subscription on the Plan page
> (development stores get a test charge). Then: Create sale → name it, choose "Percentage off" 20%, click
> "Select products" and choose any product, tick "Start immediately", choose an end time a few minutes
> ahead, click "Schedule sale". Within about 30 seconds the sale page shows "Running" and the product's price
> drops with a compare-at price. Click "End sale now" (or wait for the end time) to see original prices
> restored. Cancelling the subscription on the Plan page blocks new sales.

**Screencast script (2–3 minutes, English):**
1. Install from the listing → plan page → approve trial.
2. Create a sale on two products (one with an existing compare-at price), start immediately.
3. Open a product in Shopify admin: show sale price and compare-at.
4. Back in the app: variant table shows "On sale". End the sale now.
5. Product prices are back to the originals; variant table shows "Restored".
6. Show a scheduled sale and cancelling it; show the Plan page.

**30-second demo cut (real app, for the listing video slot or social).** Record the actual app in your dev
store; don't speed up the 30-second scheduler wait, cut it instead.

Prepare first: a dev store with 3 products (one with a compare-at price), PriceTide installed with the test
plan approved, browser at 100% zoom in a 1920×1080 window, bookmarks bar and other tabs hidden, a clean demo
store name. Record with OBS, Loom or Chrome's screen recorder at 30 fps, no cursor highlight effects, and add
captions plus licensed music afterwards.

| Time | Show (screen) | Caption on screen |
|---|---|---|
| 0–3 s | Sales list in the Shopify admin, click **Create sale** | Schedule a sale in seconds |
| 3–10 s | Type "Weekend Sale", 20% off, **Select products** → pick 3, tick **Start immediately**, set an end time, **Schedule sale** | Pick products, discount and time |
| 10–12 s | Sale page shows **Starting… → Running** (cut the wait) | Prices change on their own |
| 12–17 s | Open a product in the admin: price drops, compare-at shows the old price | Sale price + "was" price |
| 17–20 s | Back in the app: variant table **On sale**; click **End sale now** → confirm | End early anytime |
| 20–25 s | Product page: original price and compare-at restored (the one without a compare-at has none again) | Originals restored exactly |
| 25–30 s | Sales list with the ended sale, then the PriceTide logo end card from `marketing/launch-video` | PriceTide: scheduled sales for Shopify |

## 4. Live test plan (do this before submitting — catches 2.1.1/2.1.2 failures)

Run on a development store with production-like settings (deployed app, real Postgres):

- [ ] Fresh install → lands on Plan page → approve → Sales page loads with no errors
- [ ] Decline the charge → back on Plan page, no error screen
- [ ] Start-now sale → prices change within ~30 s; compare-at correct
- [ ] Variant that already had a compare-at keeps the higher one; restored exactly after
- [ ] Variant with no compare-at → compare-at cleared again after the sale (confirms Shopify clears it when
      the app sends `compareAtPrice: null`; not stated in the API docs)
- [ ] Edit a price mid-sale → kept after the end, shown as "Edited during sale"
- [ ] Scheduled sale starts and ends on time; cancel a scheduled one
- [ ] Collection sale; fixed-amount sale; .99 rounding
- [ ] Open `/app/sales/doesnotexist` → friendly "Sale not found" page
- [ ] Uninstall → reinstall → OAuth, then Plan page; no error screens; your earlier sales are still there
      if you reinstalled within 48 hours
- [ ] Plan page › Pause with a running sale → prices restored, scheduled sale on hold, plan cancelled;
      Resume → approve → Resume → scheduled sale starts
- [ ] Plan page › Permanently delete my data → typed DELETE required; sales list empty afterwards
- [ ] `/privacy` loads publicly over https; `/healthz` returns ok
- [ ] Partner Dashboard: run the automated pre-submission checks until all pass
- [ ] Check a page in Chrome incognito (third-party cookies blocked) — app still works (1.1.1)

## 5. Before you click submit

Code-side status (Oct 27, 2026): typecheck, lint, build, 72 unit tests and 16 PostgreSQL integration tests
pass; `npm audit --omit=dev` reports 0 vulnerabilities; production Docker image builds and runs healthy.

- [x] App name checked on apps.shopify.com (Oct 27, 2026); confirm when saving the listing (4.1.2)
- [ ] Separate dev app linked for `npm run dev`, so development never repoints the production app (DEPLOY.md › 0)
- [ ] App deployed on https following DEPLOY.md: `NODE_ENV=production`, `SUPPORT_EMAIL`, `APP_OWNER_NAME`,
      Neon pooled `DATABASE_URL` + direct `DIRECT_URL`, encryption key saved in a password manager
- [ ] `shopify.app.toml` has the production `application_url` and `redirect_urls`
      (`/auth/callback`), then `npm run deploy` run so webhooks, scopes and URLs are pushed
- [ ] `https://<app>/healthz` returns ok; uptime monitor and nightly backups set up (DEPLOY.md › 7–8)
- [ ] Partner Dashboard automated pre-submission checks all pass
- [ ] Live test plan above passed on a development store against the deployed app
- [ ] $19 App Store registration paid; emergency developer contact set (4.5.6)
- [ ] Listing: icon (1200×1200, no pricing/claims), 3–6 screenshots from the dev store, screencast (section 3),
      privacy policy URL `https://<app>/privacy`, Pricing section matching `PLAN_PRICE`/`TRIAL_DAYS`
      ($9.99 / 30 days, 7-day trial), support email
- [ ] Listing copy explains what sets PriceTide apart from similar apps (merchant edits kept, exact restore,
      pause/resume), without superlatives (4.3.3–4.3.4)

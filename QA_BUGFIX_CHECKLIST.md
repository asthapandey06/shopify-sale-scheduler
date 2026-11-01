# QA bug-fix checklist

Source: "PriceTide QA Test Report" (28 Oct 2026). Process per bug: debug → plan → fix → test (`npm run check`) → tick.

## Blocker
- [x] PT-01 Sale detail: End sale now / Cancel sale / Delete have no confirm button — confirm buttons moved into the banner body with per-action labels; regression test added; check passes. Browser re-test pending (owner).

## High
- [x] PT-02 Fixed amount larger than the product price is accepted — engine already skipped such variants (never $0); the create form now warns, with a tested helper. Owner to confirm the product picker returns variant prices (warning only shows if it does).
- [x] PT-03 Compare-at left behind on a merchant-edited variant after the sale ends — engine now removes only the compare-at the sale added (merchant's price and own compare-at untouched; failed cleanup retries). 3 engine tests added; check passes (79/79). Touches invariants 3 and 6.
- [x] PT-04 Plan page still shows "You're subscribed" after Pause until reload — Pause/Cancel actions now return `planCancelled`; the page applies it immediately instead of waiting on Shopify's status. check passes; UI-only, so no unit test. Browser re-test pending (owner).

## Medium
- [x] PT-05 Saved end time is one hour later than entered — not reproducible server-side (stores what the browser sends). Fixed two form causes: the end now follows an edited start, and the default end uses calendar days (no DST shift). 3 tests added incl. a DST case; check passes (82/82). Browser re-test pending (owner).
- [x] PT-06 Skipped variant shows the sale price as its "Original" — the recorded original for a variant held by another sale is the other sale's price, so the page now shows "—" (shared `BUSY_SKIP_MESSAGE`; no repo/schema change). check passes (82/82).
- [x] PT-07 Archived/draft products in a collection are discounted — gateway now reads product `status` and leaves out DRAFT/ARCHIVED for collection sales (products picked directly are kept); form note added; gateway test added; check passes (83/83).
- [x] PT-08 Sales list redirects to Plan while paused, but sale detail still loads — redirect rule extracted to `shouldRedirectToPlan` (paused shops keep read access; new installs still go to Plan). 4 tests added; check passes (87/87).

## Low
- [x] PT-09 "Edited during sale" flag only appears after the sale ends — while a sale is ACTIVE the detail page compares live Shopify prices of the shown variants (`findLiveEdits`, failure-tolerant) and flags edits immediately. 2 tests added; check passes (89/89). Browser re-test pending (owner).
- [x] PT-10 "Select at least one item" stays after products are picked — server errors on a field clear as soon as the merchant edits it or picks products (until the next failed submit). UI-only; browser re-test pending (owner).
- [x] PT-11 Wrong wording for percent 0 and negative values — messages now name the problem: 0/over 90 → "Enter a percentage above 0 and up to 90", negatives → "Enter a number above 0". Test added; check passes (91/91).
- [x] PT-12 End-before-start shows the wrong message and no red outline — "End must be after start" for an end at/before the start, and the field gets a red outline. Test added; outline needs a browser look (owner).
- [x] PT-13 Example line shown for an invalid percentage — form and server share `discountValueError`; the example line is hidden for invalid values and the field shows the error live. Tests added.
- [x] PT-14 Page does not scroll to the first error on submit — after a failed submit the page scrolls the first field with an error into view. UI-only; browser re-test pending (owner).
- [x] PT-15 Fixed amount shown as "5000 off" (no currency/format) — amounts are formatted even before a sale has a currency; list and detail look up the shop currency when it is missing. Formatter moved to `app/lib/format.ts` with tests; check passes (94/94).
- [x] PT-16 Variant rows show raw IDs instead of names — detail page looks up variant display names (failure-tolerant, falls back to the id). Test added; check passes (94/94).
- [x] PT-17 Default start time falls into the past if the form stays open — the untouched default start refreshes every 30 s while the form is open, so it never falls into the past. UI-only; browser re-test pending (owner).
- [x] PT-18 No unsaved-changes warning when leaving the create form — App Bridge `SaveBar` (with discard confirmation) appears once the form has input. UI-only; browser re-test pending (owner).
- [x] PT-19 Selected collection does not show its product count — selected collections show their product count when the picker reports it. Unverified: depends on the picker returning a count (owner to confirm).

## Notes
- All 19 are implemented; `npm run check` passes (94 tests, typecheck, lint). Nothing is committed yet.
- Needs a browser re-test by the owner (UI behaviour can't be unit-tested): PT-01, 04, 05, 09, 10, 12, 14, 17, 18, 19, and the product picker returning variant prices for PT-02.
- Engine change (PT-03) touches invariants 3 and 6; run `code-reviewer` before committing.
- No schema, scope, billing or webhook changes.

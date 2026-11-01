import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRedirectToPlan } from "../app/lib/billing-gate.ts";

test("a new install without a plan is sent to the Plan page", () => {
  assert.equal(shouldRedirectToPlan({ hasActivePayment: false, paused: false, changedPrices: 0 }), true);
});

test("a subscribed shop is never redirected", () => {
  assert.equal(shouldRedirectToPlan({ hasActivePayment: true, paused: false, changedPrices: 0 }), false);
});

test("prices still changed by a sale keep the list reachable without a plan", () => {
  assert.equal(shouldRedirectToPlan({ hasActivePayment: false, paused: false, changedPrices: 3 }), false);
});

// Regression (QA PT-08): Pause cancels the plan, but the history must stay readable.
test("a paused shop can still read its sales list", () => {
  assert.equal(shouldRedirectToPlan({ hasActivePayment: false, paused: true, changedPrices: 0 }), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDiscount, formatMoney } from "../app/lib/format.ts";

// Regression (QA PT-15): "5000 off" for a sale that has no currency yet.
test("a fixed discount is formatted with or without a known currency", () => {
  assert.equal(describeDiscount("FIXED_AMOUNT", "5000", null), "5,000.00 off");
  assert.equal(describeDiscount("FIXED_AMOUNT", "50", "USD"), "$50.00 off");
  assert.equal(describeDiscount("PERCENTAGE", "20", null), "20% off");
});

test("formatMoney keeps unreadable amounts as they are and survives an unknown currency", () => {
  assert.equal(formatMoney("abc", "USD"), "abc");
  assert.equal(formatMoney("5", "XXXX"), "5 XXXX");
});

test("an empty amount is not shown as zero", () => {
  assert.equal(formatMoney("", null), "");
  assert.equal(formatMoney("  ", "USD"), "  ");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { findLiveEdits } from "../app/lib/live-edits.ts";

const items = [
  { id: "i1", variantId: "v1", status: "APPLIED", salePrice: "80.00" },
  { id: "i2", variantId: "v2", status: "APPLIED", salePrice: "40.00" },
  { id: "i3", variantId: "v3", status: "SKIPPED", salePrice: "10.00" },
  { id: "i4", variantId: "v4", status: "APPLIED", salePrice: "5.00" },
];

// Regression (QA PT-09): a price edited during a running sale is flagged right away, not only after the sale ends.
test("flags applied variants whose live price differs from the sale price", () => {
  const live = new Map([
    ["v1", { price: "75.00" }], // edited
    ["v2", { price: "40" }], // same value, different formatting
    ["v3", { price: "99.00" }], // skipped item: not ours
  ]);
  assert.deepEqual([...findLiveEdits(items, live)], [["i1", "75.00"]]);
});

test("variants missing from the live lookup are not flagged", () => {
  assert.equal(findLiveEdits(items, new Map()).size, 0);
});

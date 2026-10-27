import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSalePrice, type PriceInput } from "../app/lib/pricing.ts";
import { formatDecimal, moneyEquals, parseDecimal } from "../app/lib/money.ts";

const base: PriceInput = {
  price: "100.00",
  compareAtPrice: null,
  discountType: "PERCENTAGE",
  discountValue: "20",
  rounding: "NONE",
  currencyCode: "USD",
};

test("money parsing and formatting is exact", () => {
  assert.equal(parseDecimal("19.99"), 19_990_000n);
  assert.equal(parseDecimal("2000.0"), 2_000_000_000n);
  assert.equal(parseDecimal("-1"), null);
  assert.equal(parseDecimal("1e3"), null);
  assert.equal(parseDecimal("abc"), null);
  assert.equal(formatDecimal(19_995_000n, 2), "20.00");
  assert.equal(formatDecimal(19_994_999n, 2), "19.99");
  assert.equal(formatDecimal(1_500_000n, 0), "2");
  assert.ok(moneyEquals("17.9", "17.90"));
  assert.ok(!moneyEquals("17.9", "17.91"));
  assert.ok(moneyEquals(null, null));
  assert.ok(!moneyEquals(null, "1"));
});

test("percentage discount without float errors", () => {
  assert.deepEqual(computeSalePrice(base), { ok: true, salePrice: "80.00", compareAtPrice: "100.00" });
  // 0.1 + 0.2 style pitfalls: 33% off 19.99 = 13.3933 -> 13.39
  assert.deepEqual(computeSalePrice({ ...base, price: "19.99", discountValue: "33" }), {
    ok: true,
    salePrice: "13.39",
    compareAtPrice: "19.99",
  });
  // 15% off 9.99 = 8.4915 -> 8.49 ; 15% off 10.10 = 8.585 -> 8.59 (half up)
  assert.equal((computeSalePrice({ ...base, price: "10.10", discountValue: "15" }) as { salePrice: string }).salePrice, "8.59");
});

test("fixed amount discount", () => {
  assert.deepEqual(computeSalePrice({ ...base, discountType: "FIXED_AMOUNT", discountValue: "5" }), {
    ok: true,
    salePrice: "95.00",
    compareAtPrice: "100.00",
  });
  const tooBig = computeSalePrice({ ...base, price: "4.00", discountType: "FIXED_AMOUNT", discountValue: "5" });
  assert.equal(tooBig.ok, false);
  const equal = computeSalePrice({ ...base, price: "5.00", discountType: "FIXED_AMOUNT", discountValue: "5" });
  assert.equal(equal.ok, false);
});

test("charm and whole rounding never exceed the computed price", () => {
  const r99 = computeSalePrice({ ...base, price: "24.00", discountValue: "25", rounding: "END_99" });
  assert.deepEqual(r99, { ok: true, salePrice: "17.99", compareAtPrice: "24.00" }); // 18.00 -> 17.99
  const r95 = computeSalePrice({ ...base, price: "50.00", discountValue: "10", rounding: "END_95" });
  assert.deepEqual(r95, { ok: true, salePrice: "44.95", compareAtPrice: "50.00" }); // 45.00 -> 44.95
  const exact = computeSalePrice({ ...base, price: "21.10", discountValue: "10", rounding: "END_99" });
  assert.equal((exact as { salePrice: string }).salePrice, "18.99"); // 18.99 stays 18.99
  const whole = computeSalePrice({ ...base, price: "21.10", discountValue: "10", rounding: "WHOLE" });
  assert.equal((whole as { salePrice: string }).salePrice, "18.00");
  // Below one unit, rounding is skipped instead of producing zero.
  const tiny = computeSalePrice({ ...base, price: "0.80", discountValue: "50", rounding: "WHOLE" });
  assert.equal((tiny as { salePrice: string }).salePrice, "0.40");
});

test("rounding that would not lower the price is rejected", () => {
  // 1% off 1.00 = 0.99 ; END_99 keeps 0.99 -> fine
  assert.equal(computeSalePrice({ ...base, price: "1.00", discountValue: "1", rounding: "END_99" }).ok, true);
  // 0.5% off 0.10 = 0.0995 -> 0.10 after cent rounding: no change
  assert.equal(computeSalePrice({ ...base, price: "0.10", discountValue: "0.5" }).ok, false);
});

test("zero-decimal currencies", () => {
  const jpy = computeSalePrice({ ...base, price: "1999", discountValue: "15", currencyCode: "JPY" });
  assert.deepEqual(jpy, { ok: true, salePrice: "1699", compareAtPrice: "1999" }); // 1699.15 -> 1699
  const jpy99 = computeSalePrice({ ...base, price: "1999", discountValue: "15", rounding: "END_99", currencyCode: "JPY" });
  assert.equal((jpy99 as { salePrice: string }).salePrice, "1699"); // charm falls back to whole units
});

test("fixed amounts finer than the currency's minor unit never yield a zero or unchanged price", () => {
  const fixed = { ...base, discountType: "FIXED_AMOUNT" as const };
  // ¥1 - ¥0.60 used to format as "0" after the zero check had already passed.
  assert.equal(computeSalePrice({ ...fixed, price: "1", discountValue: "0.60", currencyCode: "JPY" }).ok, false);
  // ¥100 - ¥0.40 used to format as "100", equal to the current price.
  assert.equal(computeSalePrice({ ...fixed, price: "100", discountValue: "0.40", currencyCode: "JPY" }).ok, false);
  assert.equal(computeSalePrice({ ...fixed, price: "1.00", discountValue: "0.996", currencyCode: "USD" }).ok, false);
  assert.equal(computeSalePrice({ ...fixed, price: "10.000", discountValue: "9.9996", currencyCode: "KWD" }).ok, false);
  // Amounts that round to a real discount still work, rounded half up to the minor unit.
  assert.deepEqual(computeSalePrice({ ...fixed, price: "100", discountValue: "0.60", currencyCode: "JPY" }), {
    ok: true,
    salePrice: "99",
    compareAtPrice: "100",
  });
});

test("existing markdowns keep the higher compare-at price", () => {
  const r = computeSalePrice({ ...base, price: "80.00", compareAtPrice: "120.00", discountValue: "10" });
  assert.deepEqual(r, { ok: true, salePrice: "72.00", compareAtPrice: "120.00" });
  const lower = computeSalePrice({ ...base, price: "80.00", compareAtPrice: "60.00", discountValue: "10" });
  assert.deepEqual(lower, { ok: true, salePrice: "72.00", compareAtPrice: "80.00" });
});

test("bad inputs are rejected, never thrown", () => {
  assert.equal(computeSalePrice({ ...base, price: "0.00" }).ok, false);
  assert.equal(computeSalePrice({ ...base, price: "oops" }).ok, false);
  assert.equal(computeSalePrice({ ...base, discountValue: "100" }).ok, false);
  assert.equal(computeSalePrice({ ...base, discountValue: "0" }).ok, false);
});

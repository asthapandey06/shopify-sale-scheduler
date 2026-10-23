import {
  SCALE,
  currencyDecimals,
  divRoundHalfUp,
  formatDecimal,
  minorUnit,
  parseDecimal,
} from "./money.ts";

export const DISCOUNT_TYPES = ["PERCENTAGE", "FIXED_AMOUNT"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const ROUNDING_MODES = ["NONE", "END_99", "END_95", "WHOLE"] as const;
export type Rounding = (typeof ROUNDING_MODES)[number];

export interface PriceInput {
  /** Current variant price, e.g. "24.00". */
  price: string;
  /** Current compare-at price, if any. */
  compareAtPrice: string | null;
  discountType: DiscountType;
  /** Percent off (e.g. "20") or amount off (e.g. "5.00"). */
  discountValue: string;
  rounding: Rounding;
  currencyCode: string;
}

export type PriceResult =
  | { ok: true; salePrice: string; compareAtPrice: string }
  | { ok: false; reason: string };

const HUNDRED_PERCENT = 100n * SCALE;

/** Largest value <= amount whose fractional part equals `ending` (internal units). */
function charmPrice(amount: bigint, ending: bigint): bigint {
  if (amount < ending) return amount;
  return ((amount - ending) / SCALE) * SCALE + ending;
}

function applyRounding(amount: bigint, rounding: Rounding, decimals: number): bigint {
  // Charm endings like .99 make no sense for currencies without minor units.
  const mode: Rounding = decimals === 0 && rounding !== "NONE" ? "WHOLE" : rounding;
  switch (mode) {
    case "NONE":
      return amount;
    case "WHOLE": {
      const whole = (amount / SCALE) * SCALE;
      return whole > 0n ? whole : amount;
    }
    case "END_99":
      return charmPrice(amount, 99n * minorUnit(2));
    case "END_95":
      return charmPrice(amount, 95n * minorUnit(2));
  }
}

/**
 * Computes the sale price for one variant.
 *
 * The discount is taken off the variant's current price. The displayed
 * compare-at price is the existing compare-at price when it is higher than the
 * current price (the variant was already marked down), otherwise the current
 * price, so shoppers always see an honest "was" price.
 */
export function computeSalePrice(input: PriceInput): PriceResult {
  const decimals = currencyDecimals(input.currencyCode);
  const base = parseDecimal(input.price);
  if (base === null) return { ok: false, reason: "Variant has an unreadable price" };
  if (base === 0n) return { ok: false, reason: "Variant price is zero" };

  const value = parseDecimal(input.discountValue);
  if (value === null || value === 0n) return { ok: false, reason: "Invalid discount value" };

  let sale: bigint;
  if (input.discountType === "PERCENTAGE") {
    if (value >= HUNDRED_PERCENT) return { ok: false, reason: "Discount must be below 100%" };
    const exact = divRoundHalfUp(base * (HUNDRED_PERCENT - value), HUNDRED_PERCENT);
    sale = divRoundHalfUp(exact, minorUnit(decimals)) * minorUnit(decimals);
  } else {
    if (value >= base) return { ok: false, reason: "Discount is larger than the price" };
    sale = base - value;
  }

  sale = applyRounding(sale, input.rounding, decimals);

  if (sale <= 0n) return { ok: false, reason: "Sale price would be zero or negative" };
  if (sale >= base) return { ok: false, reason: "Discount does not lower this price" };

  const existingCompareAt = parseDecimal(input.compareAtPrice);
  const compareAtPrice =
    existingCompareAt !== null && existingCompareAt > base && input.compareAtPrice
      ? input.compareAtPrice
      : input.price;

  return { ok: true, salePrice: formatDecimal(sale, decimals), compareAtPrice };
}

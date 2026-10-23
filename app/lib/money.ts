/**
 * Exact decimal money math using BigInt at a fixed scale.
 *
 * Shopify returns prices as decimal strings ("19.99", "2000.0"). Floating point
 * math on prices produces off-by-one-cent errors, so every calculation in this
 * app goes through these helpers instead.
 */

/** Internal scale: 1 unit = 10^-6 of the currency's major unit. */
export const SCALE = 1_000_000n;
const SCALE_DIGITS = 6;

/** Currencies Shopify formats without minor units. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** Currencies with three minor-unit digits. */
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const DECIMAL_RE = /^(\d{1,13})(?:\.(\d{1,6}))?$/;

export function currencyDecimals(currencyCode: string | null | undefined): number {
  const code = (currencyCode ?? "").toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/** Parses a non-negative decimal string. Returns null for anything malformed. */
export function parseDecimal(value: string | null | undefined): bigint | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) return null;
  const whole = BigInt(match[1]);
  const fraction = (match[2] ?? "").padEnd(SCALE_DIGITS, "0");
  return whole * SCALE + BigInt(fraction);
}

/** Integer division rounding half away from zero (inputs are non-negative). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

/** Size of one minor unit (e.g. one cent) in internal units. */
export function minorUnit(decimals: number): bigint {
  return SCALE / 10n ** BigInt(decimals);
}

/** Rounds internal units to the currency's minor unit, half up. */
export function roundToMinor(units: bigint, decimals: number): bigint {
  const step = minorUnit(decimals);
  return divRoundHalfUp(units, step) * step;
}

/** Formats internal units as a fixed-decimal string, e.g. 19990000n -> "19.99". */
export function formatDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError("negative amounts are not supported");
  const rounded = roundToMinor(units, decimals);
  const whole = rounded / SCALE;
  if (decimals === 0) return whole.toString();
  const fraction = (rounded % SCALE).toString().padStart(SCALE_DIGITS, "0").slice(0, decimals);
  return `${whole}.${fraction}`;
}

/** Numeric equality of two price strings ("17.9" equals "17.90"). */
export function moneyEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  return pa !== null && pb !== null && pa === pb;
}

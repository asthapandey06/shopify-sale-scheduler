/**
 * Formats an amount as money. Without a currency code (a sale that has not been snapshotted yet) the number is
 * still shown with separators and two decimals, e.g. 5000 -> "5,000.00".
 */
export function formatMoney(amount: string, currencyCode: string | null): string {
  const n = Number(amount);
  if (amount.trim() === "" || !Number.isFinite(n)) return amount;
  if (!currencyCode) return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(n);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

export function describeDiscount(discountType: string, discountValue: string, currencyCode: string | null): string {
  return discountType === "PERCENTAGE" ? `${discountValue}% off` : `${formatMoney(discountValue, currencyCode)} off`;
}

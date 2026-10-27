import { useSyncExternalStore } from "react";
import type { SaleStatus } from "../lib/sale-types";

type Tone = "info" | "success" | "warning" | "critical" | "neutral" | "auto";

const STATUS_LABEL: Record<SaleStatus, { label: string; tone: Tone }> = {
  SCHEDULED: { label: "Scheduled", tone: "info" },
  ACTIVATING: { label: "Starting…", tone: "warning" },
  ACTIVE: { label: "Running", tone: "success" },
  REVERTING: { label: "Restoring prices…", tone: "warning" },
  COMPLETED: { label: "Ended", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  FAILED: { label: "Failed", tone: "critical" },
};

export function StatusBadge({ status }: { status: SaleStatus }) {
  const { label, tone } = STATUS_LABEL[status] ?? { label: status, tone: "neutral" as Tone };
  return <s-badge tone={tone}>{label}</s-badge>;
}

/**
 * Renders a timestamp in the merchant's own time zone. The server doesn't know
 * the browser's zone, so the ISO string renders first and is replaced after
 * hydration (avoids hydration mismatches).
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribeNever,
    () => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    () => iso.slice(0, 16).replace("T", " ") + " UTC",
  );
  return <time dateTime={iso}>{text}</time>;
}

/** No-op subscription for useSyncExternalStore values that only differ between server and client. */
export function subscribeNever(): () => void {
  return () => {};
}

export function formatMoney(amount: string, currencyCode: string | null): string {
  const n = Number(amount);
  if (!currencyCode || !Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode }).format(n);
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

export function describeDiscount(
  discountType: string,
  discountValue: string,
  currencyCode: string | null,
): string {
  return discountType === "PERCENTAGE"
    ? `${discountValue}% off`
    : `${formatMoney(discountValue, currencyCode)} off`;
}

export const ROUNDING_LABEL: Record<string, string> = {
  NONE: "No rounding",
  END_99: "End prices in .99",
  END_95: "End prices in .95",
  WHOLE: "Round down to whole amount",
};

/** Numeric part of a Shopify GID, e.g. gid://shopify/ProductVariant/123 -> 123. */
export function gidNumber(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

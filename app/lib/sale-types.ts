import type { DiscountType, Rounding } from "./pricing.ts";
import type { SaleTarget, TargetType } from "./validation.ts";

export const SALE_STATUS = {
  SCHEDULED: "SCHEDULED",
  ACTIVATING: "ACTIVATING",
  ACTIVE: "ACTIVE",
  REVERTING: "REVERTING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;
export type SaleStatus = (typeof SALE_STATUS)[keyof typeof SALE_STATUS];

/** Sales whose prices may currently be (or are about to be) changed in Shopify. */
export const LIVE_STATUSES: SaleStatus[] = ["ACTIVATING", "ACTIVE", "REVERTING"];
/** Sales that count toward the per-shop limit. */
export const OPEN_STATUSES: SaleStatus[] = ["SCHEDULED", "ACTIVATING", "ACTIVE", "REVERTING"];
/** Sales that are finished and can be deleted. */
export const FINISHED_STATUSES: SaleStatus[] = ["COMPLETED", "CANCELLED", "FAILED"];

export const ITEM_STATUS = {
  /** Snapshot taken, sale price not yet written to Shopify. */
  PENDING: "PENDING",
  /** Sale price written to Shopify. */
  APPLIED: "APPLIED",
  /** Original price restored. */
  REVERTED: "REVERTED",
  /** Never changed (price can't be discounted, or variant is in another sale). */
  SKIPPED: "SKIPPED",
  /** Merchant edited the price during the sale; we left their edit alone. */
  CONFLICT: "CONFLICT",
  /** Shopify rejected the update. */
  FAILED: "FAILED",
} as const;
export type ItemStatus = (typeof ITEM_STATUS)[keyof typeof ITEM_STATUS];

export interface SaleRecord {
  id: string;
  shop: string;
  name: string;
  status: SaleStatus;
  discountType: DiscountType;
  discountValue: string;
  rounding: Rounding;
  targetType: TargetType;
  targets: SaleTarget[];
  startsAt: Date;
  endsAt: Date;
  currencyCode: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  appliedAt: Date | null;
  revertedAt: Date | null;
}

export interface SaleItemRecord {
  id: string;
  saleId: string;
  shop: string;
  productId: string;
  variantId: string;
  originalPrice: string;
  originalCompareAtPrice: string | null;
  salePrice: string;
  saleCompareAtPrice: string | null;
  status: ItemStatus;
  message: string | null;
}

export type NewSaleItem = Omit<SaleItemRecord, "id">;

export type SalePatch = Partial<
  Pick<SaleRecord, "status" | "currencyCode" | "attempts" | "nextAttemptAt" | "lastError" | "appliedAt" | "revertedAt" | "endsAt">
>;

export interface AuditEntry {
  shop: string;
  saleId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

/** Persistence used by the sale engine. Every method is scoped to one shop or sale. */
export interface SaleRepo {
  findDueSales(now: Date, limit: number): Promise<SaleRecord[]>;
  claimShop(shop: string, owner: string, leaseUntil: Date, now: Date): Promise<boolean>;
  /** Extends the lease; false if this owner no longer holds it (another worker took over). */
  renewShop(shop: string, owner: string, leaseUntil: Date): Promise<boolean>;
  releaseShop(shop: string, owner: string): Promise<void>;
  getSale(shop: string, saleId: string): Promise<SaleRecord | null>;
  updateSale(shop: string, saleId: string, patch: SalePatch): Promise<void>;
  countItems(saleId: string): Promise<number>;
  insertItems(items: NewSaleItem[]): Promise<void>;
  listItems(saleId: string, statuses: ItemStatus[]): Promise<SaleItemRecord[]>;
  setItemStatuses(updates: { id: string; status: ItemStatus; message: string | null }[]): Promise<void>;
  findBusyVariants(shop: string, excludeSaleId: string, variantIds: string[]): Promise<Set<string>>;
  isBillingActive(shop: string): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface VariantPrice {
  id: string;
  productId: string;
  price: string;
  compareAtPrice: string | null;
}

export interface VariantUpdate {
  id: string;
  price: string;
  compareAtPrice: string | null;
}

export interface UpdateResult {
  updated: string[];
  failed: { id: string; message: string }[];
}

/** The Shopify Admin API operations the engine needs. */
export interface AdminGateway {
  getShopCurrency(): Promise<string>;
  /** Returns variants for the targets; stops early once more than `cap` are found. */
  listTargetVariants(targetType: TargetType, ids: string[], cap: number): Promise<VariantPrice[]>;
  /** Current prices; variants that no longer exist are absent from the map. */
  getVariantPrices(variantIds: string[]): Promise<Map<string, VariantPrice>>;
  updateVariantPrices(productId: string, updates: VariantUpdate[]): Promise<UpdateResult>;
}

/** This worker no longer holds the shop lease; it must stop touching the shop's prices. */
export class LeaseLostError extends Error {
  constructor(shop: string) {
    super(`Lost the lease for ${shop}`);
    this.name = "LeaseLostError";
  }
}

/** Errors that will not succeed on retry (bad data, limits exceeded). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

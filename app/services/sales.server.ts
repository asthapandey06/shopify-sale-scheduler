import prisma from "../db.server";
import { config } from "../config.server";
import { logger } from "../lib/logger";
import { createRateLimiter } from "../lib/rate-limit";
import {
  FINISHED_STATUSES,
  LIVE_STATUSES,
  ITEM_STATUS,
  OPEN_STATUSES,
  SALE_STATUS,
  type ItemStatus,
} from "../lib/sale-types";
import type { SaleInput } from "../lib/validation";
import { toSaleRecord } from "./sale-repo.server";

/** All functions here take the shop from the verified session, never from client input. */

const mutationLimiter = createRateLimiter({ capacity: 20, refillPerMinute: 30 });

export class HttpError extends Error {
  status: number;
  publicMessage: string;
  headers: Record<string, string>;
  constructor(status: number, publicMessage: string, headers: Record<string, string> = {}) {
    super(publicMessage);
    this.status = status;
    this.publicMessage = publicMessage;
    this.headers = headers;
  }
}

export function enforceRateLimit(shop: string): void {
  if (!mutationLimiter.take(shop)) {
    throw new HttpError(429, "Too many requests. Please wait a moment and try again.", {
      "Retry-After": String(mutationLimiter.retryAfterSeconds(shop)),
    });
  }
}

export async function listSales(shop: string) {
  const rows = await prisma.sale.findMany({
    where: { shop },
    orderBy: [{ startsAt: "desc" }],
    take: 200,
  });
  return rows.map(toSaleRecord);
}

export async function getSaleDetail(shop: string, saleId: string) {
  const row = await prisma.sale.findFirst({ where: { id: saleId, shop } });
  if (!row) return null;
  const [counts, items] = await Promise.all([
    prisma.saleItem.groupBy({ by: ["status"], where: { saleId }, _count: { _all: true } }),
    prisma.saleItem.findMany({
      where: { saleId },
      orderBy: [{ status: "asc" }, { productId: "asc" }],
      take: 500,
      select: {
        id: true,
        productId: true,
        variantId: true,
        originalPrice: true,
        originalCompareAtPrice: true,
        salePrice: true,
        saleCompareAtPrice: true,
        status: true,
        message: true,
      },
    }),
  ]);
  const statusCounts: Partial<Record<ItemStatus, number>> = {};
  for (const c of counts) statusCounts[c.status as ItemStatus] = c._count._all;
  return { sale: toSaleRecord(row), statusCounts, items };
}

export async function createSale(shop: string, input: SaleInput): Promise<string> {
  const open = await prisma.sale.count({ where: { shop, status: { in: OPEN_STATUSES } } });
  if (open >= config.limits.maxLiveSalesPerShop) {
    throw new HttpError(
      422,
      `You can have up to ${config.limits.maxLiveSalesPerShop} scheduled or running sales. End or cancel one first.`,
    );
  }
  const sale = await prisma.sale.create({
    data: {
      shop,
      name: input.name,
      status: SALE_STATUS.SCHEDULED,
      discountType: input.discountType,
      discountValue: input.discountValue,
      rounding: input.rounding,
      targetType: input.targetType,
      targets: JSON.stringify(input.targets),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    },
    select: { id: true },
  });
  await audit(shop, sale.id, "sale.created", {
    discountType: input.discountType,
    discountValue: input.discountValue,
    targets: input.targets.length,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
  });
  return sale.id;
}

/** Cancels a sale that has not started. Atomic: loses the race if it just started. */
export async function cancelSale(shop: string, saleId: string): Promise<boolean> {
  const result = await prisma.sale.updateMany({
    where: { id: saleId, shop, status: SALE_STATUS.SCHEDULED },
    data: { status: SALE_STATUS.CANCELLED },
  });
  if (result.count === 1) await audit(shop, saleId, "sale.cancelled");
  return result.count === 1;
}

/** Ends a running sale now; the scheduler restores prices within seconds. */
export async function endSaleNow(shop: string, saleId: string): Promise<boolean> {
  const result = await prisma.sale.updateMany({
    where: { id: saleId, shop, status: SALE_STATUS.ACTIVE },
    data: { endsAt: new Date(), nextAttemptAt: null },
  });
  if (result.count === 1) await audit(shop, saleId, "sale.ended_early");
  return result.count === 1;
}

/**
 * Restores original prices for a failed sale that still has changed prices
 * (e.g. the app was uninstalled mid-sale and has now been reinstalled).
 */
export async function restoreSale(shop: string, saleId: string): Promise<boolean> {
  const stillApplied = await prisma.saleItem.count({ where: { saleId, shop, status: ITEM_STATUS.APPLIED } });
  if (stillApplied === 0) return false;
  const result = await prisma.sale.updateMany({
    where: { id: saleId, shop, status: SALE_STATUS.FAILED },
    data: { status: SALE_STATUS.REVERTING, endsAt: new Date(), attempts: 0, nextAttemptAt: null, lastError: null },
  });
  if (result.count === 1) await audit(shop, saleId, "sale.restore_requested");
  return result.count === 1;
}

/** Deletes a finished sale and its history. Refuses if any price is still changed. */
export async function deleteSale(shop: string, saleId: string): Promise<boolean> {
  const stillApplied = await prisma.saleItem.count({ where: { saleId, shop, status: ITEM_STATUS.APPLIED } });
  if (stillApplied > 0) return false;
  const result = await prisma.sale.deleteMany({ where: { id: saleId, shop, status: { in: FINISHED_STATUSES } } });
  if (result.count === 1) await audit(shop, saleId, "sale.deleted");
  return result.count === 1;
}

export async function countRunningSales(shop: string): Promise<number> {
  return prisma.sale.count({
    where: { shop, status: { in: [SALE_STATUS.ACTIVATING, SALE_STATUS.ACTIVE, SALE_STATUS.REVERTING] } },
  });
}

export async function audit(shop: string, saleId: string | null, action: string, detail?: Record<string, unknown>) {
  try {
    await prisma.auditLog.create({
      data: { shop, saleId, action, detail: detail ? JSON.stringify(detail).slice(0, 2000) : null },
    });
  } catch (error) {
    logger.error("Failed to write audit log", { shop, action, error: (error as Error).message });
  }
}

/**
 * Pauses PriceTide for the shop ("deactivate, resume later"): running sales end now (the scheduler
 * restores their prices), scheduled sales are kept but won't start until resumed, and a sale that is
 * starting right now is rolled back by the scheduler. Billing is cancelled by the caller. Idempotent.
 */
export async function pauseShop(shop: string): Promise<{ endedSales: number }> {
  const now = new Date();
  const [, ended] = await prisma.$transaction([
    prisma.shop.upsert({ where: { shop }, create: { shop, pausedAt: now }, update: { pausedAt: now } }),
    prisma.sale.updateMany({
      where: { shop, status: SALE_STATUS.ACTIVE },
      data: { endsAt: now, nextAttemptAt: null },
    }),
  ]);
  await audit(shop, null, "shop.paused", { endedSales: ended.count });
  return { endedSales: ended.count };
}

export async function resumeShop(shop: string): Promise<void> {
  await prisma.shop.updateMany({ where: { shop }, data: { pausedAt: null } });
  await audit(shop, null, "shop.resumed");
}

export async function isShopPaused(shop: string): Promise<boolean> {
  const row = await prisma.shop.findUnique({ where: { shop }, select: { pausedAt: true } });
  return row?.pausedAt != null;
}

/**
 * "Permanently delete my data": removes all sales, their items and the history, so the merchant starts
 * fresh. The session and plan are kept so the app keeps working. Refused while any price is still
 * changed. The delete itself only matches sales that can't be changing prices, so a sale the scheduler
 * starts at the same moment survives rather than leaving discounts with no record.
 */
export async function deleteAllSaleData(shop: string): Promise<number> {
  const unsafe = await prisma.sale.count({
    where: {
      shop,
      OR: [{ status: { in: LIVE_STATUSES } }, { items: { some: { status: ITEM_STATUS.APPLIED } } }],
    },
  });
  if (unsafe > 0) {
    throw new HttpError(
      409,
      "Some sales are running or still have changed prices. End them (or restore prices) first, then try again.",
    );
  }
  const [deleted] = await prisma.$transaction([
    prisma.sale.deleteMany({
      where: {
        shop,
        status: { in: [SALE_STATUS.SCHEDULED, ...FINISHED_STATUSES] },
        items: { none: { status: ITEM_STATUS.APPLIED } },
      },
    }),
    prisma.auditLog.deleteMany({ where: { shop } }),
  ]);
  logger.info("Merchant deleted all sale data", { shop, deletedSales: deleted.count });
  return deleted.count;
}

/** Retention safety net if shop/redact never arrives: erase shops uninstalled before `cutoff`. */
export async function purgeUninstalledShops(cutoff: Date): Promise<number> {
  const stale = await prisma.shop.findMany({ where: { uninstalledAt: { lt: cutoff } }, select: { shop: true } });
  let purged = 0;
  for (const { shop } of stale) {
    // Re-checked inside the transaction (the Shop row is deleted first, which locks it): a shop that
    // reinstalled since the query above has uninstalledAt cleared and is left alone.
    const erased = await prisma.$transaction(async (tx) => {
      const { count } = await tx.shop.deleteMany({ where: { shop, uninstalledAt: { lt: cutoff } } });
      if (count === 0) return false;
      await tx.saleItem.deleteMany({ where: { shop } });
      await tx.sale.deleteMany({ where: { shop } });
      await tx.auditLog.deleteMany({ where: { shop } });
      await tx.session.deleteMany({ where: { shop } });
      return true;
    });
    if (erased) {
      purged += 1;
      logger.info("Purged data of a shop uninstalled past the retention period", { shop });
    }
  }
  return purged;
}

/** Deletes everything stored for a shop (shop/redact). */
export async function purgeShopData(shop: string): Promise<void> {
  await prisma.$transaction([
    prisma.saleItem.deleteMany({ where: { shop } }),
    prisma.sale.deleteMany({ where: { shop } }),
    prisma.auditLog.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
    prisma.shop.deleteMany({ where: { shop } }),
  ]);
}

/**
 * After uninstall the access token is revoked, so prices can no longer be
 * changed. Scheduled sales are cancelled; running ones are flagged so the
 * merchant sees what happened if they reinstall.
 */
export async function handleUninstall(shop: string, triggeredAt?: Date): Promise<boolean> {
  if (triggeredAt) {
    const row = await prisma.shop.findUnique({ where: { shop }, select: { installedAt: true } });
    if (row && row.installedAt.getTime() > triggeredAt.getTime()) {
      // A late retry of an uninstall that happened before the merchant reinstalled.
      logger.warn("Ignoring app/uninstalled triggered before the latest install", { shop });
      return false;
    }
  }
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { shop } }),
    prisma.sale.updateMany({
      where: { shop, status: SALE_STATUS.SCHEDULED },
      data: { status: SALE_STATUS.CANCELLED, lastError: "Cancelled because the app was uninstalled." },
    }),
    prisma.sale.updateMany({
      where: { shop, status: { in: [SALE_STATUS.ACTIVATING, SALE_STATUS.ACTIVE, SALE_STATUS.REVERTING] } },
      data: {
        status: SALE_STATUS.FAILED,
        lastError: "The app was uninstalled while this sale was running, so prices could not be restored automatically.",
      },
    }),
    prisma.shop.updateMany({
      where: { shop },
      data: { billingActive: false, uninstalledAt: new Date(), lockOwner: null, lockedUntil: null },
    }),
  ]);
  return true;
}

/**
 * app_subscriptions/update: keeps the stored plan status current when a subscription is approved,
 * cancelled, frozen (unpaid) or expires, so the background worker never starts a sale for a shop that
 * isn't paying. Only our plan counts. Returns the subscription status it read (for logging).
 */
export async function applySubscriptionUpdate(shop: string, payload: unknown, planName: string): Promise<string> {
  const sub = (payload as { app_subscription?: { name?: unknown; status?: unknown } } | null)?.app_subscription;
  const status = typeof sub?.status === "string" ? sub.status.toUpperCase() : "";
  const name = typeof sub?.name === "string" ? sub.name : null;
  if (name === planName && status) {
    await prisma.shop.updateMany({
      where: { shop },
      data: { billingActive: status === "ACTIVE", planName: status === "ACTIVE" ? name : null },
    });
  }
  return status;
}

export async function setBillingStatus(shop: string, active: boolean, planName: string | null): Promise<void> {
  await prisma.shop.upsert({
    where: { shop },
    create: { shop, billingActive: active, planName },
    update: { billingActive: active, planName },
  });
}

export async function isTestBillingShop(shop: string): Promise<boolean> {
  if (config.billing.testMode) return true;
  const row = await prisma.shop.findUnique({ where: { shop }, select: { isDevStore: true } });
  return row?.isDevStore ?? false;
}

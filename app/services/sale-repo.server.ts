import type { Prisma, PrismaClient, Sale as SaleRow, SaleItem as SaleItemRow } from "@prisma/client";
import prisma from "../db.server";
import type { DiscountType, Rounding } from "../lib/pricing";
import {
  ITEM_STATUS,
  LIVE_STATUSES,
  SALE_STATUS,
  type ItemStatus,
  type SaleItemRecord,
  type SaleRecord,
  type SaleRepo,
  type SaleStatus,
} from "../lib/sale-types";
import type { SaleTarget, TargetType } from "../lib/validation";

const CHUNK = 500;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseTargets(raw: string): SaleTarget[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((t): t is SaleTarget => !!t && typeof t === "object" && typeof (t as SaleTarget).id === "string")
      .map((t) => ({ id: t.id, title: typeof t.title === "string" ? t.title : t.id }));
  } catch {
    return [];
  }
}

export function toSaleRecord(row: SaleRow): SaleRecord {
  return {
    id: row.id,
    shop: row.shop,
    name: row.name,
    status: row.status as SaleStatus,
    discountType: row.discountType as DiscountType,
    discountValue: row.discountValue,
    rounding: row.rounding as Rounding,
    targetType: row.targetType as TargetType,
    targets: parseTargets(row.targets),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    currencyCode: row.currencyCode,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
    appliedAt: row.appliedAt,
    revertedAt: row.revertedAt,
  };
}

function toItemRecord(row: SaleItemRow): SaleItemRecord {
  return {
    id: row.id,
    saleId: row.saleId,
    shop: row.shop,
    productId: row.productId,
    variantId: row.variantId,
    originalPrice: row.originalPrice,
    originalCompareAtPrice: row.originalCompareAtPrice,
    salePrice: row.salePrice,
    saleCompareAtPrice: row.saleCompareAtPrice,
    status: row.status as ItemStatus,
    message: row.message,
  };
}

/** Ensures a Shop row exists (safe under concurrent calls). */
export async function ensureShop(shop: string, db: PrismaClient = prisma): Promise<void> {
  await db.shop.upsert({
    where: { shop },
    create: { shop },
    update: { uninstalledAt: null },
  });
}

export function createPrismaSaleRepo(db: PrismaClient = prisma): SaleRepo {
  return {
    async findDueSales(now, limit) {
      const rows = await db.sale.findMany({
        where: {
          AND: [
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
            {
              OR: [
                { status: SALE_STATUS.SCHEDULED, startsAt: { lte: now } },
                { status: SALE_STATUS.ACTIVE, endsAt: { lte: now } },
                { status: { in: [SALE_STATUS.ACTIVATING, SALE_STATUS.REVERTING] } },
              ],
            },
          ],
        },
        orderBy: { startsAt: "asc" },
        take: limit,
      });
      return rows.map(toSaleRecord);
    },

    async claimShop(shop, owner, leaseUntil, now) {
      try {
        await db.shop.upsert({ where: { shop }, create: { shop }, update: {} });
      } catch (error) {
        // P2002 = another worker created the row at the same moment; that's fine.
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      // Single atomic UPDATE: only succeeds if the lease is free, expired, or ours.
      const result = await db.shop.updateMany({
        where: {
          shop,
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }, { lockOwner: owner }],
        },
        data: { lockOwner: owner, lockedUntil: leaseUntil },
      });
      return result.count === 1;
    },

    async renewShop(shop, owner, leaseUntil) {
      await db.shop.updateMany({ where: { shop, lockOwner: owner }, data: { lockedUntil: leaseUntil } });
    },

    async releaseShop(shop, owner) {
      await db.shop.updateMany({ where: { shop, lockOwner: owner }, data: { lockOwner: null, lockedUntil: null } });
    },

    async getSale(shop, saleId) {
      const row = await db.sale.findFirst({ where: { id: saleId, shop } });
      return row ? toSaleRecord(row) : null;
    },

    async updateSale(shop, saleId, patch) {
      await db.sale.updateMany({ where: { id: saleId, shop }, data: patch });
    },

    async countItems(saleId) {
      return db.saleItem.count({ where: { saleId } });
    },

    async insertItems(items) {
      // One transaction: the snapshot is all-or-nothing.
      await db.$transaction(
        chunk(items).map((part) => db.saleItem.createMany({ data: part, skipDuplicates: true })),
      );
    },

    async listItems(saleId, statuses) {
      const rows = await db.saleItem.findMany({
        where: { saleId, status: { in: statuses } },
        orderBy: [{ productId: "asc" }, { variantId: "asc" }],
      });
      return rows.map(toItemRecord);
    },

    async setItemStatuses(updates) {
      if (updates.length === 0) return;
      // Group identical (status, message) pairs into a single UPDATE each.
      const groups = new Map<string, { status: ItemStatus; message: string | null; ids: string[] }>();
      for (const u of updates) {
        const key = `${u.status}\u0000${u.message ?? ""}`;
        const group = groups.get(key) ?? { status: u.status, message: u.message, ids: [] };
        group.ids.push(u.id);
        groups.set(key, group);
      }
      const ops: Prisma.PrismaPromise<unknown>[] = [];
      for (const group of groups.values()) {
        for (const ids of chunk(group.ids)) {
          ops.push(db.saleItem.updateMany({ where: { id: { in: ids } }, data: { status: group.status, message: group.message } }));
        }
      }
      await db.$transaction(ops);
    },

    async findBusyVariants(shop, excludeSaleId, variantIds) {
      const busy = new Set<string>();
      for (const ids of chunk(variantIds)) {
        const rows = await db.saleItem.findMany({
          where: {
            shop,
            saleId: { not: excludeSaleId },
            variantId: { in: ids },
            // APPLIED means the sale price is in Shopify, whatever the sale's status (e.g. FAILED after an
            // uninstall, awaiting restore). PENDING only blocks while its sale may still write it.
            OR: [
              { status: ITEM_STATUS.APPLIED },
              { status: ITEM_STATUS.PENDING, sale: { status: { in: LIVE_STATUSES } } },
            ],
          },
          select: { variantId: true },
        });
        for (const row of rows) busy.add(row.variantId);
      }
      return busy;
    },

    async isBillingActive(shop) {
      const row = await db.shop.findUnique({ where: { shop }, select: { billingActive: true } });
      return row?.billingActive ?? false;
    },

    async audit(entry) {
      await db.auditLog.create({
        data: {
          shop: entry.shop,
          saleId: entry.saleId,
          action: entry.action,
          detail: entry.detail ? JSON.stringify(entry.detail).slice(0, 2000) : null,
        },
      });
    },
  };
}

import {
  ITEM_STATUS,
  LIVE_STATUSES,
  SALE_STATUS,
  type AuditEntry,
  type ItemStatus,
  type NewSaleItem,
  type SaleItemRecord,
  type SalePatch,
  type SaleRecord,
  type SaleRepo,
} from "./sale-types.ts";

/**
 * In-memory SaleRepo with the same semantics as the Prisma implementation.
 * Used by the test suite (and handy for local experiments).
 */
export function createMemoryRepo() {
  const sales = new Map<string, SaleRecord>();
  const items = new Map<string, SaleItemRecord>();
  const shops = new Map<string, { billingActive: boolean; lockOwner: string | null; lockedUntil: Date | null }>();
  const auditLog: AuditEntry[] = [];
  let seq = 0;

  const shopRow = (shop: string) => {
    let row = shops.get(shop);
    if (!row) {
      row = { billingActive: false, lockOwner: null, lockedUntil: null };
      shops.set(shop, row);
    }
    return row;
  };

  const repo: SaleRepo = {
    async findDueSales(now, limit) {
      const t = now.getTime();
      return [...sales.values()]
        .filter((s) => !s.nextAttemptAt || s.nextAttemptAt.getTime() <= t)
        .filter(
          (s) =>
            (s.status === SALE_STATUS.SCHEDULED && s.startsAt.getTime() <= t) ||
            (s.status === SALE_STATUS.ACTIVE && s.endsAt.getTime() <= t) ||
            s.status === SALE_STATUS.ACTIVATING ||
            s.status === SALE_STATUS.REVERTING,
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, limit)
        .map((s) => ({ ...s }));
    },
    async claimShop(shop, owner, leaseUntil, now) {
      const row = shopRow(shop);
      const free = !row.lockedUntil || row.lockedUntil.getTime() < now.getTime() || row.lockOwner === owner;
      if (!free) return false;
      row.lockOwner = owner;
      row.lockedUntil = leaseUntil;
      return true;
    },
    async renewShop(shop, owner, leaseUntil) {
      const row = shopRow(shop);
      if (row.lockOwner === owner) row.lockedUntil = leaseUntil;
    },
    async releaseShop(shop, owner) {
      const row = shopRow(shop);
      if (row.lockOwner === owner) {
        row.lockOwner = null;
        row.lockedUntil = null;
      }
    },
    async getSale(shop, saleId) {
      const sale = sales.get(saleId);
      return sale && sale.shop === shop ? { ...sale } : null;
    },
    async updateSale(shop, saleId, patch: SalePatch) {
      const sale = sales.get(saleId);
      if (sale && sale.shop === shop) Object.assign(sale, patch);
    },
    async countItems(saleId) {
      return [...items.values()].filter((i) => i.saleId === saleId).length;
    },
    async insertItems(newItems: NewSaleItem[]) {
      for (const item of newItems) {
        const exists = [...items.values()].some((i) => i.saleId === item.saleId && i.variantId === item.variantId);
        if (exists) continue;
        const id = `item_${++seq}`;
        items.set(id, { ...item, id });
      }
    },
    async listItems(saleId, statuses: ItemStatus[]) {
      return [...items.values()].filter((i) => i.saleId === saleId && statuses.includes(i.status)).map((i) => ({ ...i }));
    },
    async setItemStatuses(updates) {
      for (const update of updates) {
        const item = items.get(update.id);
        if (item) {
          item.status = update.status;
          item.message = update.message;
        }
      }
    },
    async findBusyVariants(shop, excludeSaleId, variantIds) {
      const wanted = new Set(variantIds);
      const busy = new Set<string>();
      for (const item of items.values()) {
        if (item.shop !== shop || item.saleId === excludeSaleId || !wanted.has(item.variantId)) continue;
        if (item.status === ITEM_STATUS.APPLIED) {
          busy.add(item.variantId);
        } else if (item.status === ITEM_STATUS.PENDING) {
          const sale = sales.get(item.saleId);
          if (sale && LIVE_STATUSES.includes(sale.status)) busy.add(item.variantId);
        }
      }
      return busy;
    },
    async isBillingActive(shop) {
      return shopRow(shop).billingActive;
    },
    async audit(entry) {
      auditLog.push(entry);
    },
  };

  return {
    repo,
    sales,
    items,
    auditLog,
    setBilling(shop: string, active: boolean) {
      shopRow(shop).billingActive = active;
    },
    shopLock(shop: string) {
      const row = shopRow(shop);
      return { owner: row.lockOwner, until: row.lockedUntil };
    },
    addSale(sale: Omit<SaleRecord, "attempts" | "nextAttemptAt" | "lastError" | "appliedAt" | "revertedAt" | "currencyCode"> & Partial<SaleRecord>) {
      const full: SaleRecord = {
        currencyCode: null,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
        appliedAt: null,
        revertedAt: null,
        ...sale,
      };
      sales.set(full.id, full);
      return full;
    },
  };
}

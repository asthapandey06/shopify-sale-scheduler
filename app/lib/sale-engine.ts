import { moneyEquals } from "./money.ts";
import { computeSalePrice } from "./pricing.ts";
import type { Logger } from "./logger.ts";
import {
  ITEM_STATUS,
  PermanentError,
  SALE_STATUS,
  type AdminGateway,
  type ItemStatus,
  type NewSaleItem,
  type SaleItemRecord,
  type SaleRecord,
  type SaleRepo,
} from "./sale-types.ts";

/**
 * Applies and reverts scheduled sales.
 *
 * Safety properties:
 * - Original prices are snapshotted to the database BEFORE anything is written
 *   to Shopify, so a crash at any point can always be reverted.
 * - Work is resumable and idempotent: re-running a step writes the same values.
 * - A per-shop lease guarantees only one worker touches a shop's prices at a
 *   time, even with several app instances.
 * - On revert, a variant is only restored if its price is still the sale price;
 *   if the merchant edited it during the sale, their edit wins.
 * - Reverts never give up; a failed activation that already changed prices is
 *   rolled back automatically.
 */

export interface EngineDeps {
  repo: SaleRepo;
  gateway: (shop: string) => Promise<AdminGateway>;
  now: () => Date;
  logger: Logger;
  /** Identifies this worker for the shop lease. */
  owner: string;
  maxVariantsPerSale: number;
  leaseMs?: number;
  maxActivationAttempts?: number;
  /** Variants per Shopify mutation / lookup call. */
  batchSize?: number;
}

export interface TickResult {
  processed: number;
  skippedLocked: number;
  errors: number;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVATION_ATTEMPTS = 5;
const DEFAULT_BATCH = 100;

export function backoffMs(attempt: number, capMs: number): number {
  return Math.min(capMs, 60_000 * 2 ** Math.max(0, attempt - 1));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function groupByProduct<T extends { productId: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.productId) ?? [];
    list.push(item);
    groups.set(item.productId, list);
  }
  return groups;
}

function sameCompareAt(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : moneyEquals(a, b);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export function createSaleEngine(deps: EngineDeps) {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const maxActivationAttempts = deps.maxActivationAttempts ?? DEFAULT_MAX_ACTIVATION_ATTEMPTS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const { repo, logger, owner } = deps;

  const lease = () => new Date(deps.now().getTime() + leaseMs);
  const renew = (shop: string) => repo.renewShop(shop, owner, lease());

  async function snapshot(sale: SaleRecord, gateway: AdminGateway): Promise<void> {
    const currencyCode = sale.currencyCode ?? (await gateway.getShopCurrency());
    if (!sale.currencyCode) {
      await repo.updateSale(sale.shop, sale.id, { currencyCode });
    }

    const variants = await gateway.listTargetVariants(
      sale.targetType,
      sale.targets.map((t) => t.id),
      deps.maxVariantsPerSale,
    );
    if (variants.length > deps.maxVariantsPerSale) {
      throw new PermanentError(
        `This sale covers more than ${deps.maxVariantsPerSale} variants. Split it into smaller sales.`,
      );
    }
    if (variants.length === 0) {
      throw new PermanentError("The selected products or collections have no variants.");
    }

    const busy = await repo.findBusyVariants(sale.shop, sale.id, variants.map((v) => v.id));
    const items: NewSaleItem[] = variants.map((variant) => {
      const base = {
        saleId: sale.id,
        shop: sale.shop,
        productId: variant.productId,
        variantId: variant.id,
        originalPrice: variant.price,
        originalCompareAtPrice: variant.compareAtPrice,
      };
      if (busy.has(variant.id)) {
        return { ...base, salePrice: variant.price, saleCompareAtPrice: variant.compareAtPrice, status: ITEM_STATUS.SKIPPED, message: "Already part of another running sale" };
      }
      const result = computeSalePrice({
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        discountType: sale.discountType,
        discountValue: sale.discountValue,
        rounding: sale.rounding,
        currencyCode,
      });
      if (!result.ok) {
        return { ...base, salePrice: variant.price, saleCompareAtPrice: variant.compareAtPrice, status: ITEM_STATUS.SKIPPED, message: result.reason };
      }
      return { ...base, salePrice: result.salePrice, saleCompareAtPrice: result.compareAtPrice, status: ITEM_STATUS.PENDING, message: null };
    });

    await repo.insertItems(items);
    await repo.audit({
      shop: sale.shop,
      saleId: sale.id,
      action: "sale.snapshot",
      detail: { variants: items.length, toChange: items.filter((i) => i.status === ITEM_STATUS.PENDING).length },
    });
  }

  async function writePrices(
    shop: string,
    gateway: AdminGateway,
    items: SaleItemRecord[],
    pick: (item: SaleItemRecord) => { price: string; compareAtPrice: string | null },
    successStatus: ItemStatus,
    failureStatus: ItemStatus,
  ): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;
    for (const [productId, productItems] of groupByProduct(items)) {
      for (const part of chunk(productItems, batchSize)) {
        const result = await gateway.updateVariantPrices(
          productId,
          part.map((item) => ({ id: item.variantId, ...pick(item) })),
        );
        const byVariant = new Map(part.map((item) => [item.variantId, item]));
        const updates: { id: string; status: ItemStatus; message: string | null }[] = [];
        for (const variantId of result.updated) {
          const item = byVariant.get(variantId);
          if (item) updates.push({ id: item.id, status: successStatus, message: null });
        }
        for (const failure of result.failed) {
          const item = byVariant.get(failure.id);
          if (item) updates.push({ id: item.id, status: failureStatus, message: failure.message.slice(0, 500) });
        }
        await repo.setItemStatuses(updates);
        succeeded += result.updated.length;
        failed += result.failed.length;
        await renew(shop);
      }
    }
    return { succeeded, failed };
  }

  async function activate(sale: SaleRecord): Promise<void> {
    const now = deps.now();

    if (sale.status === SALE_STATUS.SCHEDULED && sale.endsAt.getTime() <= now.getTime()) {
      await repo.updateSale(sale.shop, sale.id, {
        status: SALE_STATUS.FAILED,
        lastError: "The sale window passed before it could start (the app was offline or unreachable).",
      });
      await repo.audit({ shop: sale.shop, saleId: sale.id, action: "sale.missed" });
      return;
    }

    if (sale.status === SALE_STATUS.SCHEDULED) {
      await repo.updateSale(sale.shop, sale.id, { status: SALE_STATUS.ACTIVATING });
    }

    try {
      if (!(await repo.isBillingActive(sale.shop))) {
        throw new Error("The shop has no active subscription. Choose a plan to run sales.");
      }
      const gateway = await deps.gateway(sale.shop);
      if ((await repo.countItems(sale.id)) === 0) {
        await snapshot(sale, gateway);
      }
      const pending = await repo.listItems(sale.id, [ITEM_STATUS.PENDING]);
      const { failed } = await writePrices(
        sale.shop,
        gateway,
        pending,
        (item) => ({ price: item.salePrice, compareAtPrice: item.saleCompareAtPrice }),
        ITEM_STATUS.APPLIED,
        ITEM_STATUS.FAILED,
      );

      await repo.updateSale(sale.shop, sale.id, {
        status: SALE_STATUS.ACTIVE,
        appliedAt: deps.now(),
        attempts: 0,
        nextAttemptAt: null,
        lastError: failed > 0 ? `${failed} variant(s) could not be updated. See the item list for details.` : null,
      });
      await repo.audit({ shop: sale.shop, saleId: sale.id, action: "sale.activated", detail: { failedVariants: failed } });
      logger.info("Sale activated", { shop: sale.shop, saleId: sale.id, failedVariants: failed });
    } catch (error) {
      const attempts = sale.attempts + 1;
      const message = errorMessage(error);
      const permanent = error instanceof PermanentError;

      if (permanent || attempts >= maxActivationAttempts) {
        const applied = await repo.listItems(sale.id, [ITEM_STATUS.APPLIED]);
        if (applied.length > 0) {
          // Some prices already changed: roll them back right away.
          await repo.updateSale(sale.shop, sale.id, {
            status: SALE_STATUS.REVERTING,
            endsAt: deps.now(),
            attempts: 0,
            nextAttemptAt: null,
            lastError: `Could not finish starting the sale, rolling back: ${message}`,
          });
        } else {
          await repo.updateSale(sale.shop, sale.id, { status: SALE_STATUS.FAILED, attempts, nextAttemptAt: null, lastError: message });
        }
        await repo.audit({ shop: sale.shop, saleId: sale.id, action: "sale.activation_failed", detail: { message, attempts } });
        logger.error("Sale activation failed", { shop: sale.shop, saleId: sale.id, error: message, attempts });
      } else {
        await repo.updateSale(sale.shop, sale.id, {
          status: SALE_STATUS.ACTIVATING,
          attempts,
          nextAttemptAt: new Date(deps.now().getTime() + backoffMs(attempts, 15 * 60_000)),
          lastError: message,
        });
        logger.warn("Sale activation will retry", { shop: sale.shop, saleId: sale.id, error: message, attempts });
      }
    }
  }

  async function revert(sale: SaleRecord): Promise<void> {
    if (sale.status === SALE_STATUS.ACTIVE) {
      await repo.updateSale(sale.shop, sale.id, { status: SALE_STATUS.REVERTING });
    }

    try {
      const gateway = await deps.gateway(sale.shop);
      // PENDING and FAILED items may have been written before a crash, so they
      // are checked against live prices too.
      const items = await repo.listItems(sale.id, [ITEM_STATUS.APPLIED, ITEM_STATUS.PENDING, ITEM_STATUS.FAILED]);
      let stillApplied = 0;

      for (const part of chunk(items, batchSize)) {
        const live = await gateway.getVariantPrices(part.map((i) => i.variantId));
        const toRestore: SaleItemRecord[] = [];
        const statusUpdates: { id: string; status: ItemStatus; message: string | null }[] = [];

        for (const item of part) {
          const current = live.get(item.variantId);
          if (!current) {
            statusUpdates.push({ id: item.id, status: ITEM_STATUS.SKIPPED, message: "Variant no longer exists" });
          } else if (moneyEquals(current.price, item.salePrice)) {
            toRestore.push(item);
          } else if (item.status !== ITEM_STATUS.APPLIED && moneyEquals(current.price, item.originalPrice)) {
            statusUpdates.push({ id: item.id, status: ITEM_STATUS.SKIPPED, message: "Price was never changed" });
          } else if (
            moneyEquals(current.price, item.originalPrice) &&
            sameCompareAt(current.compareAtPrice, item.originalCompareAtPrice)
          ) {
            // Already restored (e.g. a crash after the restore but before this status was saved).
            statusUpdates.push({ id: item.id, status: ITEM_STATUS.REVERTED, message: null });
          } else {
            statusUpdates.push({
              id: item.id,
              status: ITEM_STATUS.CONFLICT,
              message: `Price was edited during the sale (now ${current.price}); left unchanged`,
            });
          }
        }
        await repo.setItemStatuses(statusUpdates);

        // Failed restores stay APPLIED so the next attempt retries them.
        const { failed } = await writePrices(
          sale.shop,
          gateway,
          toRestore,
          (item) => ({ price: item.originalPrice, compareAtPrice: item.originalCompareAtPrice }),
          ITEM_STATUS.REVERTED,
          ITEM_STATUS.APPLIED,
        );
        stillApplied += failed;
        await renew(sale.shop);
      }

      if (stillApplied > 0) {
        throw new Error(`${stillApplied} variant(s) could not be restored yet`);
      }

      await repo.updateSale(sale.shop, sale.id, {
        status: SALE_STATUS.COMPLETED,
        revertedAt: deps.now(),
        attempts: 0,
        nextAttemptAt: null,
      });
      await repo.audit({ shop: sale.shop, saleId: sale.id, action: "sale.reverted" });
      logger.info("Sale reverted", { shop: sale.shop, saleId: sale.id });
    } catch (error) {
      const attempts = sale.attempts + 1;
      const message = errorMessage(error);
      await repo.updateSale(sale.shop, sale.id, {
        status: SALE_STATUS.REVERTING,
        attempts,
        nextAttemptAt: new Date(deps.now().getTime() + backoffMs(attempts, 30 * 60_000)),
        lastError: `Restoring prices, will retry: ${message}`,
      });
      logger.error("Sale revert failed; will retry", { shop: sale.shop, saleId: sale.id, error: message, attempts });
    }
  }

  async function processSale(shop: string, saleId: string): Promise<void> {
    // Re-read under the lease: the sale may have been cancelled or finished.
    const sale = await repo.getSale(shop, saleId);
    if (!sale) return;
    const now = deps.now().getTime();
    if (sale.nextAttemptAt && sale.nextAttemptAt.getTime() > now) return;

    if (sale.status === SALE_STATUS.SCHEDULED && sale.startsAt.getTime() <= now) {
      await activate(sale);
    } else if (sale.status === SALE_STATUS.ACTIVATING) {
      await activate(sale);
    } else if (
      (sale.status === SALE_STATUS.ACTIVE && sale.endsAt.getTime() <= now) ||
      sale.status === SALE_STATUS.REVERTING
    ) {
      await revert(sale);
    }
  }

  /** Processes all due sales once. Safe to call concurrently from many workers. */
  async function tick(limit = 50): Promise<TickResult> {
    const result: TickResult = { processed: 0, skippedLocked: 0, errors: 0 };
    const due = await repo.findDueSales(deps.now(), limit);
    const byShop = new Map<string, string[]>();
    for (const sale of due) {
      byShop.set(sale.shop, [...(byShop.get(sale.shop) ?? []), sale.id]);
    }

    for (const [shop, saleIds] of byShop) {
      if (!(await repo.claimShop(shop, owner, lease(), deps.now()))) {
        result.skippedLocked += saleIds.length;
        continue;
      }
      try {
        for (const saleId of saleIds) {
          try {
            await processSale(shop, saleId);
            result.processed += 1;
          } catch (error) {
            // Only bookkeeping failures land here (e.g. the database is down).
            result.errors += 1;
            logger.error("Unexpected error while processing sale", { shop, saleId, error: errorMessage(error) });
          }
        }
      } finally {
        await repo.releaseShop(shop, owner).catch((error) =>
          logger.error("Failed to release shop lease", { shop, error: errorMessage(error) }),
        );
      }
    }
    return result;
  }

  return { tick, processSale, activate, revert };
}

export type SaleEngine = ReturnType<typeof createSaleEngine>;

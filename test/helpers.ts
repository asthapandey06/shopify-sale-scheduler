import type { AdminGateway, UpdateResult, VariantPrice, VariantUpdate } from "../app/lib/sale-types.ts";
import type { Logger } from "../app/lib/logger.ts";
import type { TargetType } from "../app/lib/validation.ts";

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake Shopify store that behaves like the Admin API for the calls we use. */
export function createFakeStore(currency = "USD") {
  const variants = new Map<string, VariantPrice>();
  const collections = new Map<string, string[]>();
  const calls = { updates: 0, lookups: 0 };
  const failVariants = new Set<string>();
  let failNextUpdates = 0;
  let loseNextResponses = 0;

  const gateway: AdminGateway = {
    async getShopCurrency() {
      return currency;
    },
    async listTargetVariants(targetType: TargetType, ids: string[], cap: number) {
      const productIds =
        targetType === "PRODUCTS" ? ids : [...new Set(ids.flatMap((id) => collections.get(id) ?? []))];
      const out: VariantPrice[] = [];
      for (const productId of productIds) {
        for (const v of variants.values()) {
          if (v.productId === productId) out.push({ ...v });
          if (out.length > cap) return out;
        }
      }
      return out;
    },
    async getVariantPrices(ids: string[]) {
      calls.lookups += 1;
      const map = new Map<string, VariantPrice>();
      for (const id of ids) {
        const v = variants.get(id);
        if (v) map.set(id, { ...v });
      }
      return map;
    },
    async updateVariantPrices(productId: string, updates: VariantUpdate[]): Promise<UpdateResult> {
      calls.updates += 1;
      if (failNextUpdates > 0) {
        failNextUpdates -= 1;
        throw new Error("Shopify is unavailable (simulated)");
      }
      const result: UpdateResult = { updated: [], failed: [] };
      for (const u of updates) {
        const v = variants.get(u.id);
        if (!v || v.productId !== productId) {
          result.failed.push({ id: u.id, message: "Variant not found" });
        } else if (failVariants.has(u.id)) {
          result.failed.push({ id: u.id, message: "Price is invalid (simulated)" });
        } else {
          v.price = u.price;
          v.compareAtPrice = u.compareAtPrice;
          result.updated.push(u.id);
        }
      }
      if (loseNextResponses > 0) {
        loseNextResponses -= 1;
        throw new Error("Request timed out after Shopify applied it (simulated)");
      }
      return result;
    },
  };

  return {
    gateway,
    variants,
    collections,
    calls,
    failVariants,
    failUpdates(n: number) {
      failNextUpdates = n;
    },
    /** The next n updates are applied in the store, but the caller gets an error. */
    loseResponses(n: number) {
      loseNextResponses = n;
    },
    addProduct(productId: string, list: { id: string; price: string; compareAtPrice?: string | null }[]) {
      for (const v of list) {
        variants.set(v.id, { id: v.id, productId, price: v.price, compareAtPrice: v.compareAtPrice ?? null });
      }
    },
  };
}

export function clock(start: string) {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
    set(iso: string) {
      t = new Date(iso).getTime();
    },
  };
}

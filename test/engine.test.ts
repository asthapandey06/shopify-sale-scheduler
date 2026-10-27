import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaleEngine, type EngineDeps } from "../app/lib/sale-engine.ts";
import { createMemoryRepo } from "../app/lib/memory-repo.ts";
import type { SaleRecord } from "../app/lib/sale-types.ts";
import { clock, createFakeStore, silentLogger } from "./helpers.ts";

const SHOP = "demo.myshopify.com";

function setup(overrides: Partial<EngineDeps> = {}) {
  const mem = createMemoryRepo();
  const store = createFakeStore();
  const time = clock("2026-11-01T10:00:00Z");
  mem.setBilling(SHOP, true);
  store.addProduct("gid://shopify/Product/1", [
    { id: "gid://shopify/ProductVariant/11", price: "100.00" },
    { id: "gid://shopify/ProductVariant/12", price: "50.00", compareAtPrice: "70.00" },
  ]);
  store.addProduct("gid://shopify/Product/2", [{ id: "gid://shopify/ProductVariant/21", price: "0.00" }]);
  store.collections.set("gid://shopify/Collection/9", ["gid://shopify/Product/1", "gid://shopify/Product/2"]);

  const engine = createSaleEngine({
    repo: mem.repo,
    gateway: async () => store.gateway,
    now: time.now,
    logger: silentLogger,
    owner: "worker-a",
    maxVariantsPerSale: 100,
    ...overrides,
  });

  const addSale = (partial: Partial<SaleRecord> = {}) =>
    mem.addSale({
      id: partial.id ?? "sale_1",
      shop: SHOP,
      name: "Black Friday",
      status: "SCHEDULED",
      discountType: "PERCENTAGE",
      discountValue: "20",
      rounding: "NONE",
      targetType: "PRODUCTS",
      targets: [{ id: "gid://shopify/Product/1", title: "Shirt" }],
      startsAt: new Date("2026-11-01T10:00:00Z"),
      endsAt: new Date("2026-11-01T12:00:00Z"),
      ...partial,
    });

  const price = (id: string) => store.variants.get(`gid://shopify/ProductVariant/${id}`)!;
  return { mem, store, time, engine, addSale, price };
}

test("applies a sale at start and restores exact originals at end", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale();

  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
  assert.deepEqual([price("11").price, price("11").compareAtPrice], ["80.00", "100.00"]);
  // Already marked down: keeps its higher compare-at price.
  assert.deepEqual([price("12").price, price("12").compareAtPrice], ["40.00", "70.00"]);

  await engine.tick(); // not due yet
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");

  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
  assert.deepEqual([price("11").price, price("11").compareAtPrice], ["100.00", null]);
  assert.deepEqual([price("12").price, price("12").compareAtPrice], ["50.00", "70.00"]);
  assert.equal(mem.shopLock(SHOP).owner, null, "lease released");
});

test("collections expand to variants and unsalable variants are skipped", async () => {
  const { mem, engine, addSale, price } = setup();
  addSale({ targetType: "COLLECTIONS", targets: [{ id: "gid://shopify/Collection/9", title: "All" }] });
  await engine.tick();
  assert.equal(price("21").price, "0.00");
  const skipped = [...mem.items.values()].filter((i) => i.status === "SKIPPED");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].message, "Variant price is zero");
});

test("a price edited by the merchant during the sale is left alone", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  addSale();
  await engine.tick();
  store.variants.get("gid://shopify/ProductVariant/11")!.price = "75.00"; // merchant edit
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(price("11").price, "75.00");
  assert.equal(price("12").price, "50.00");
  const conflict = [...mem.items.values()].find((i) => i.variantId.endsWith("/11"))!;
  assert.equal(conflict.status, "CONFLICT");
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
});

test("transient Shopify errors retry with backoff, then succeed", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  addSale();
  store.failUpdates(1);
  await engine.tick();
  const sale = mem.sales.get("sale_1")!;
  assert.equal(sale.status, "ACTIVATING");
  assert.equal(sale.attempts, 1);
  assert.ok(sale.nextAttemptAt && sale.nextAttemptAt > time.now());

  await engine.tick(); // still backing off
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVATING");

  time.advance(61_000);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
  assert.equal(price("11").price, "80.00");
  // The snapshot was taken once; originals are not overwritten by the retry.
  assert.equal(mem.items.size, 2);
  assert.equal([...mem.items.values()].find((i) => i.variantId.endsWith("/11"))!.originalPrice, "100.00");
});

test("activation that keeps failing after partial changes rolls back", async () => {
  const { mem, store, time, engine, addSale, price } = setup({ maxActivationAttempts: 2, batchSize: 1 });
  addSale();
  // First variant succeeds, then every call fails.
  const realUpdate = store.gateway.updateVariantPrices;
  let n = 0;
  store.gateway.updateVariantPrices = async (productId, updates) => {
    n += 1;
    if (n > 1) throw new Error("boom");
    return realUpdate(productId, updates);
  };
  await engine.tick();
  assert.equal(price("11").price, "80.00");
  time.advance(61_000);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "REVERTING");

  store.gateway.updateVariantPrices = realUpdate;
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
  assert.equal(price("11").price, "100.00");
  assert.equal(price("12").price, "50.00");
});

test("variants rejected by Shopify are reported but do not block the sale", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  store.failVariants.add("gid://shopify/ProductVariant/12");
  addSale();
  await engine.tick();
  const sale = mem.sales.get("sale_1")!;
  assert.equal(sale.status, "ACTIVE");
  assert.match(sale.lastError ?? "", /1 variant/);
  store.failVariants.clear();
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
  assert.equal(price("11").price, "100.00");
  assert.equal(price("12").price, "50.00");
});

test("reverts never give up and keep retrying", async () => {
  const { mem, store, time, engine, addSale, price } = setup({ maxActivationAttempts: 1 });
  addSale();
  await engine.tick();
  time.set("2026-11-01T12:00:00Z");
  store.failUpdates(10);
  for (let i = 0; i < 10; i += 1) {
    await engine.tick();
    time.advance(31 * 60_000);
  }
  assert.equal(mem.sales.get("sale_1")!.status, "REVERTING");
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
  assert.equal(price("11").price, "100.00");
});

test("no active subscription: sale does not start", async () => {
  const { mem, engine, addSale, price } = setup({ maxActivationAttempts: 1 });
  mem.setBilling(SHOP, false);
  addSale();
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "FAILED");
  assert.equal(price("11").price, "100.00");
});

test("ending still works after the subscription lapses", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale();
  await engine.tick();
  mem.setBilling(SHOP, false);
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
  assert.equal(price("11").price, "100.00");
});

test("overlapping sales never discount the same variant twice", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale({ id: "sale_1" });
  await engine.tick();
  addSale({ id: "sale_2", startsAt: time.now(), endsAt: new Date("2026-11-01T11:00:00Z") });
  await engine.tick();
  assert.equal(mem.sales.get("sale_2")!.status, "ACTIVE");
  assert.equal(price("11").price, "80.00", "not 64.00");
  const s2Items = [...mem.items.values()].filter((i) => i.saleId === "sale_2");
  assert.ok(s2Items.every((i) => i.status === "SKIPPED"));

  time.set("2026-11-01T11:00:00Z");
  await engine.tick(); // sale_2 ends: must not touch sale_1 prices
  assert.equal(price("11").price, "80.00");
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(price("11").price, "100.00");
});

test("a shop leased by another worker is skipped", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale();
  await mem.repo.claimShop(SHOP, "worker-b", new Date(time.now().getTime() + 60_000), time.now());
  const result = await engine.tick();
  assert.equal(result.skippedLocked, 1);
  assert.equal(price("11").price, "100.00");
  // Expired leases can be taken over (crashed worker).
  time.advance(61_000);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
});

test("a sale whose window passed while offline is marked failed, not started", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale();
  time.set("2026-11-01T13:00:00Z");
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "FAILED");
  assert.equal(price("11").price, "100.00");
});

test("too many variants fails permanently before touching prices", async () => {
  const { mem, engine, addSale, price } = setup({ maxVariantsPerSale: 1 });
  addSale();
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "FAILED");
  assert.match(mem.sales.get("sale_1")!.lastError ?? "", /more than 1 variants/);
  assert.equal(price("11").price, "100.00");
});

test("cancelled sales are never processed", async () => {
  const { mem, engine, addSale, price } = setup();
  addSale({ status: "CANCELLED" });
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "CANCELLED");
  assert.equal(price("11").price, "100.00");
});

test("a crash between Shopify write and bookkeeping is recovered on revert", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale();
  await engine.tick();
  // Simulate lost bookkeeping: item still PENDING although Shopify has the sale price.
  for (const item of mem.items.values()) item.status = "PENDING";
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(price("11").price, "100.00");
  assert.equal(price("12").price, "50.00");
});

test("variants still discounted by a failed sale are not stacked by a new sale", async () => {
  const { mem, time, engine, addSale, price } = setup();
  addSale({ id: "sale_1" });
  await engine.tick();
  // The app was uninstalled mid-sale: the sale is FAILED but its prices are still in Shopify.
  mem.sales.get("sale_1")!.status = "FAILED";
  addSale({ id: "sale_2", startsAt: time.now(), endsAt: new Date("2026-11-01T11:00:00Z") });
  await engine.tick();
  assert.equal(price("11").price, "80.00", "not 64.00");
  const s2Items = [...mem.items.values()].filter((i) => i.saleId === "sale_2");
  assert.ok(s2Items.every((i) => i.status === "SKIPPED"));
  assert.ok(s2Items.every((i) => i.originalPrice !== "80.00" || i.status === "SKIPPED"));
});

test("a crash after restoring but before bookkeeping is recorded as reverted, not a conflict", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  addSale();
  await engine.tick();
  // Shopify already has the originals back, but the items are still APPLIED (crash before the status write).
  store.variants.get("gid://shopify/ProductVariant/11")!.price = "100.00";
  store.variants.get("gid://shopify/ProductVariant/11")!.compareAtPrice = null;
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  const item = [...mem.items.values()].find((i) => i.variantId.endsWith("/11"))!;
  assert.equal(item.status, "REVERTED");
  assert.equal(price("11").price, "100.00");
  assert.equal(mem.sales.get("sale_1")!.status, "COMPLETED");
});

test("an activation retry leaves prices the merchant changed after the snapshot alone", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  addSale();
  store.failUpdates(1);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVATING");
  store.variants.get("gid://shopify/ProductVariant/11")!.price = "120.00"; // merchant edit between attempts
  time.advance(61_000);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
  assert.equal(price("11").price, "120.00", "not the stale 80.00");
  assert.equal(price("12").price, "40.00");
  const item = [...mem.items.values()].find((i) => i.variantId.endsWith("/11"))!;
  assert.equal(item.status, "CONFLICT");

  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(price("11").price, "120.00", "merchant's price survives the end of the sale");
  assert.equal(price("12").price, "50.00");
});

test("an update applied by Shopify whose response was lost is not written twice", async () => {
  const { mem, store, time, engine, addSale, price } = setup();
  addSale();
  store.loseResponses(1);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVATING");
  assert.equal(price("11").price, "80.00");
  const updatesBefore = store.calls.updates;
  time.advance(61_000);
  await engine.tick();
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
  assert.equal(store.calls.updates, updatesBefore, "already-applied prices are recorded, not rewritten");
  assert.ok([...mem.items.values()].every((i) => i.status === "APPLIED"));
  time.set("2026-11-01T12:00:00Z");
  await engine.tick();
  assert.equal(price("11").price, "100.00");
  assert.equal(price("12").price, "50.00");
});

test("a worker that lost its shop lease stops before writing prices", async () => {
  const { mem, store, time, engine, addSale, price } = setup({ leaseMs: 60_000 });
  addSale();
  const realList = store.gateway.listTargetVariants;
  store.gateway.listTargetVariants = async (...args) => {
    // A slow snapshot: the lease expires and another instance takes over the shop.
    time.advance(61_000);
    await mem.repo.claimShop(SHOP, "worker-b", new Date(time.now().getTime() + 60_000), time.now());
    return realList(...args);
  };
  await engine.tick();
  assert.equal(price("11").price, "100.00");
  assert.equal(price("12").price, "50.00");
  assert.equal(store.calls.updates, 0);
  const sale = mem.sales.get("sale_1")!;
  assert.equal(sale.attempts, 0, "losing the lease is not a failed attempt");
  assert.equal(mem.shopLock(SHOP).owner, "worker-b", "the new owner's lease is untouched");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTickRunner } from "../app/lib/tick-runner.ts";
import { createSaleEngine } from "../app/lib/sale-engine.ts";
import { createMemoryRepo } from "../app/lib/memory-repo.ts";
import type { TickResult } from "../app/lib/sale-engine.ts";
import { clock, createFakeStore, silentLogger } from "./helpers.ts";

const SHOP = "demo.myshopify.com";
const EMPTY: TickResult = { processed: 0, skippedLocked: 0, errors: 0 };

/** A tick whose completion the test controls. */
function controlledTick() {
  let calls = 0;
  let finish: (result: TickResult) => void = () => {};
  const tick = () => {
    calls += 1;
    return new Promise<TickResult>((resolve) => {
      finish = resolve;
    });
  };
  return { tick, finish: (r: TickResult = EMPTY) => finish(r), calls: () => calls };
}

test("concurrent runTick calls share one pass", async () => {
  const t = controlledTick();
  const runner = createTickRunner(t.tick, silentLogger);
  const a = runner.runTick();
  const b = runner.runTick();
  assert.equal(a, b);
  assert.equal(t.calls(), 1);
  t.finish({ processed: 2, skippedLocked: 0, errors: 0 });
  assert.deepEqual(await a, { processed: 2, skippedLocked: 0, errors: 0 });

  const c = runner.runTick(); // the previous pass is done, so a new one starts
  assert.equal(t.calls(), 2);
  t.finish();
  await c;
});

test("a failing pass resolves to null and the next pass still runs", async () => {
  let n = 0;
  const runner = createTickRunner(async () => {
    n += 1;
    if (n === 1) throw new Error("database is down");
    return EMPTY;
  }, silentLogger);
  assert.equal(await runner.runTick(), null);
  assert.deepEqual(await runner.runTick(), EMPTY);
});

test("stop waits for the in-flight pass and starts no new ones", async () => {
  const t = controlledTick();
  const runner = createTickRunner(t.tick, silentLogger);
  const pass = runner.runTick();
  const stopped = runner.stop(5_000);
  assert.equal(runner.stopping, true);
  assert.equal(await runner.runTick(), null, "no new pass while stopping");
  assert.equal(t.calls(), 1);
  t.finish();
  await pass;
  assert.equal(await stopped, true);
});

test("stop gives up after its timeout if a pass hangs", async () => {
  const t = controlledTick();
  const runner = createTickRunner(t.tick, silentLogger);
  void runner.runTick();
  assert.equal(await runner.stop(20), false);
  t.finish();
});

function engineSetup() {
  const mem = createMemoryRepo();
  const store = createFakeStore();
  const time = clock("2026-11-01T10:00:00Z");
  mem.setBilling(SHOP, true);
  store.addProduct("gid://shopify/Product/1", [
    { id: "gid://shopify/ProductVariant/11", price: "100.00" },
    { id: "gid://shopify/ProductVariant/12", price: "50.00" },
  ]);
  mem.addSale({
    id: "sale_1",
    shop: SHOP,
    name: "Sale",
    status: "SCHEDULED",
    discountType: "PERCENTAGE",
    discountValue: "20",
    rounding: "NONE",
    targetType: "PRODUCTS",
    targets: [{ id: "gid://shopify/Product/1", title: "Shirt" }],
    startsAt: new Date("2026-11-01T10:00:00Z"),
    endsAt: new Date("2026-11-01T12:00:00Z"),
  });
  const engine = (owner: string) =>
    createSaleEngine({
      repo: mem.repo,
      gateway: async () => store.gateway,
      now: time.now,
      logger: silentLogger,
      owner,
      maxVariantsPerSale: 100,
    });
  return { mem, store, engine };
}

test("two app instances ticking at once apply a sale exactly once", async () => {
  const { mem, store, engine } = engineSetup();
  const [a, b] = await Promise.all([engine("instance-a").tick(), engine("instance-b").tick()]);
  assert.equal(a.processed + b.processed, 1);
  assert.equal(a.skippedLocked + b.skippedLocked, 1);
  assert.equal(store.variants.get("gid://shopify/ProductVariant/11")!.price, "80.00", "not 64.00");
  assert.equal(store.calls.updates, 1);
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
  assert.equal(mem.shopLock(SHOP).owner, null);
});

test("shutdown lets the in-flight pass finish and release its shop lease", async () => {
  const { mem, store, engine } = engineSetup();
  const realUpdate = store.gateway.updateVariantPrices;
  let resume: (() => void) | null = null;
  store.gateway.updateVariantPrices = async (productId, updates) => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return realUpdate(productId, updates);
  };
  const runner = createTickRunner(() => engine("instance-a").tick(), silentLogger);
  const pass = runner.runTick();
  // Wait until the pass is in the middle of writing prices.
  while (!resume) await new Promise((r) => setImmediate(r));
  assert.equal(mem.shopLock(SHOP).owner, "instance-a", "lease held mid-pass");

  const stopped = runner.stop(5_000);
  (resume as () => void)();
  assert.equal(await stopped, true);
  await pass;
  assert.equal(mem.shopLock(SHOP).owner, null, "lease released before exit");
  assert.equal(mem.sales.get("sale_1")!.status, "ACTIVE");
});

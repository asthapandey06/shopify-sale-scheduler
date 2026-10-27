// Integration tests against a real PostgreSQL database (DATABASE_URL). Run with `npm run test:db`.
// They cover what only the database can prove: Prisma queries, shop scoping and webhook handlers.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

// Config is validated when the server modules load, so set placeholders first (no real secrets).
process.env.SHOPIFY_API_KEY ||= "test-key";
process.env.SHOPIFY_API_SECRET ||= "test-secret";
process.env.SHOPIFY_APP_URL ||= "https://pricetide.test";
process.env.TOKEN_ENCRYPTION_KEYS ||= `t1:${randomBytes(32).toString("base64")}`;
// Off, so the dev-store flag decides whether a shop gets test charges.
process.env.BILLING_TEST_MODE = "false";

const { Prisma } = await import("@prisma/client");
const { default: prisma } = await import("../../app/db.server.ts");
const sales = await import("../../app/services/sales.server.ts");
const { createPrismaSaleRepo } = await import("../../app/services/sale-repo.server.ts");
const { toErrorResponse, assertId } = await import("../../app/services/http.server.ts");

const run = randomUUID().slice(0, 8);
const SHOP = `itest-${run}.myshopify.com`;
const OTHER = `itest-${run}-other.myshopify.com`;
const PLAN = "PriceTide Pro";

async function cleanup() {
  for (const shop of [SHOP, OTHER]) await sales.purgeShopData(shop);
}

async function seedShop(shop: string) {
  await prisma.shop.create({ data: { shop, billingActive: true, lockOwner: "w", lockedUntil: new Date(Date.now() + 60_000) } });
  await prisma.session.create({ data: { id: `offline_${shop}`, shop, state: "s", accessToken: "ciphertext" } });
  const sale = (status: string) =>
    prisma.sale.create({
      data: {
        shop,
        name: status,
        status,
        discountType: "PERCENTAGE",
        discountValue: "10",
        rounding: "NONE",
        targetType: "PRODUCTS",
        targets: "[]",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
      },
    });
  const ids: Record<string, string> = {};
  for (const status of ["SCHEDULED", "ACTIVATING", "ACTIVE", "REVERTING", "COMPLETED"]) ids[status] = (await sale(status)).id;
  await prisma.saleItem.create({
    data: {
      saleId: ids.ACTIVE,
      shop,
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/1",
      originalPrice: "10.00",
      salePrice: "9.00",
      saleCompareAtPrice: "10.00",
      status: "APPLIED",
    },
  });
  await prisma.auditLog.create({ data: { shop, saleId: ids.ACTIVE, action: "sale.created" } });
  return ids;
}

const statusOf = async (id: string) => (await prisma.sale.findUniqueOrThrow({ where: { id } })).status;

before(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("app/uninstalled: sessions removed, sales stopped, lease and billing cleared; idempotent and shop-scoped", async () => {
  const ids = await seedShop(SHOP);
  const otherIds = await seedShop(OTHER);
  await sales.handleUninstall(SHOP);
  await sales.handleUninstall(SHOP); // webhooks can be delivered more than once

  assert.equal(await prisma.session.count({ where: { shop: SHOP } }), 0);
  assert.equal(await statusOf(ids.SCHEDULED), "CANCELLED");
  for (const live of ["ACTIVATING", "ACTIVE", "REVERTING"]) assert.equal(await statusOf(ids[live]), "FAILED");
  assert.equal(await statusOf(ids.COMPLETED), "COMPLETED");
  const shop = await prisma.shop.findUniqueOrThrow({ where: { shop: SHOP } });
  assert.equal(shop.billingActive, false);
  assert.equal(shop.lockOwner, null);
  assert.ok(shop.uninstalledAt);

  // Another shop is untouched.
  assert.equal(await prisma.session.count({ where: { shop: OTHER } }), 1);
  assert.equal(await statusOf(otherIds.ACTIVE), "ACTIVE");
  await cleanup();
});

test("shop/redact: every table with shop data is emptied for that shop only; idempotent", async () => {
  await seedShop(SHOP);
  await seedShop(OTHER);
  await sales.purgeShopData(SHOP);
  await sales.purgeShopData(SHOP);

  // Every model with a `shop` column, so a new table can't be forgotten.
  const shopModels = Prisma.dmmf.datamodel.models.filter((m) => m.fields.some((f) => f.name === "shop"));
  assert.ok(shopModels.length >= 5);
  for (const model of shopModels) {
    const delegate = (prisma as unknown as Record<string, { count(args: object): Promise<number> }>)[
      model.name.charAt(0).toLowerCase() + model.name.slice(1)
    ];
    assert.equal(await delegate.count({ where: { shop: SHOP } }), 0, `${model.name} rows left for the redacted shop`);
    assert.ok((await delegate.count({ where: { shop: OTHER } })) > 0, `${model.name} rows of another shop were deleted`);
  }
  await cleanup();
});

test("app_subscriptions/update: only our plan's status counts; idempotent", async () => {
  await prisma.shop.create({ data: { shop: SHOP, billingActive: false } });
  const update = (status: string, name = PLAN) =>
    sales.applySubscriptionUpdate(SHOP, { app_subscription: { name, status } }, PLAN);
  const active = async () => (await prisma.shop.findUniqueOrThrow({ where: { shop: SHOP } })).billingActive;

  assert.equal(await update("active"), "ACTIVE");
  await update("ACTIVE");
  assert.equal(await active(), true);
  await update("ACTIVE", "Some other plan");
  await update("CANCELLED", "Some other plan");
  assert.equal(await active(), true, "other plans are ignored");
  for (const status of ["FROZEN", "CANCELLED", "EXPIRED", "DECLINED"]) {
    await update("ACTIVE");
    await update(status);
    assert.equal(await active(), false, `${status} turns billing off`);
  }
  assert.equal(await sales.applySubscriptionUpdate(SHOP, null, PLAN), "", "malformed payloads are ignored");
  await cleanup();
});

test("merchant actions only touch the session's own shop", async () => {
  const otherIds = await seedShop(OTHER);
  await prisma.shop.create({ data: { shop: SHOP } });
  assert.equal(await sales.cancelSale(SHOP, otherIds.SCHEDULED), false);
  assert.equal(await sales.endSaleNow(SHOP, otherIds.ACTIVE), false);
  assert.equal(await sales.deleteSale(SHOP, otherIds.COMPLETED), false);
  assert.equal(await sales.getSaleDetail(SHOP, otherIds.ACTIVE), null);
  assert.equal((await sales.listSales(SHOP)).length, 0);
  assert.equal(await statusOf(otherIds.SCHEDULED), "SCHEDULED");
  assert.equal(await statusOf(otherIds.COMPLETED), "COMPLETED");
  await cleanup();
});

test("a sale with prices still changed can't be deleted", async () => {
  const ids = await seedShop(SHOP);
  await prisma.sale.update({ where: { id: ids.ACTIVE }, data: { status: "FAILED" } });
  assert.equal(await sales.deleteSale(SHOP, ids.ACTIVE), false, "APPLIED item remains");
  assert.equal(await sales.restoreSale(SHOP, ids.ACTIVE), true);
  assert.equal(await statusOf(ids.ACTIVE), "REVERTING");
  assert.equal(await sales.deleteSale(SHOP, ids.COMPLETED), true);
  await cleanup();
});

test("Prisma repo: compare-and-set status, lease fencing and busy variants match the memory repo", async () => {
  const ids = await seedShop(SHOP);
  await prisma.shop.update({ where: { shop: SHOP }, data: { lockOwner: null, lockedUntil: null } });
  const repo = createPrismaSaleRepo(prisma);
  const now = new Date();
  const soon = new Date(now.getTime() + 60_000);

  assert.equal(await repo.updateSale(SHOP, ids.SCHEDULED, { status: "ACTIVATING" }, "ACTIVE"), false);
  assert.equal(await statusOf(ids.SCHEDULED), "SCHEDULED");
  assert.equal(await repo.updateSale(SHOP, ids.SCHEDULED, { status: "ACTIVATING" }, "SCHEDULED"), true);
  assert.equal(await repo.updateSale(OTHER, ids.SCHEDULED, { status: "FAILED" }), false, "scoped by shop");

  assert.equal(await repo.claimShop(SHOP, "a", soon, now), true);
  assert.equal(await repo.claimShop(SHOP, "b", soon, now), false);
  assert.equal(await repo.renewShop(SHOP, "a", soon), true);
  assert.equal(await repo.renewShop(SHOP, "b", soon), false, "a non-owner can't renew");
  await repo.releaseShop(SHOP, "a");
  assert.equal(await repo.claimShop(SHOP, "b", soon, now), true);

  // An APPLIED item blocks other sales even after its own sale FAILED (e.g. uninstalled mid-sale).
  const variant = "gid://shopify/ProductVariant/1";
  await prisma.sale.update({ where: { id: ids.ACTIVE }, data: { status: "FAILED" } });
  assert.deepEqual([...(await repo.findBusyVariants(SHOP, ids.SCHEDULED, [variant]))], [variant]);
  await prisma.saleItem.updateMany({ where: { saleId: ids.ACTIVE }, data: { status: "PENDING" } });
  assert.equal((await repo.findBusyVariants(SHOP, ids.SCHEDULED, [variant])).size, 0, "PENDING of a dead sale doesn't block");
  await prisma.sale.update({ where: { id: ids.ACTIVE }, data: { status: "ACTIVATING" } });
  assert.equal((await repo.findBusyVariants(SHOP, ids.SCHEDULED, [variant])).size, 1, "PENDING of a live sale blocks");
  await cleanup();
});

test("development stores get test charges", async () => {
  await prisma.shop.create({ data: { shop: SHOP, isDevStore: true } });
  await prisma.shop.create({ data: { shop: OTHER, isDevStore: false } });
  assert.equal(await sales.isTestBillingShop(SHOP), true, "development store");
  assert.equal(await sales.isTestBillingShop(OTHER), false, "real store with test mode off");
  assert.equal(await sales.isTestBillingShop(`unknown-${SHOP}`), false);
  await cleanup();
});

test("error responses are generic and keep details out of the client", async () => {
  const known = toErrorResponse(new sales.HttpError(429, "Too many requests.", { "Retry-After": "5" }));
  assert.equal(known.init?.status, 429);
  assert.deepEqual(known.data, { ok: false, message: "Too many requests." });
  const unknown = toErrorResponse(new Error(`connect ECONNREFUSED postgres://user:secret@db/${SHOP}`));
  assert.equal(unknown.init?.status, 500);
  assert.deepEqual(unknown.data, { ok: false, message: "Something went wrong. Please try again." });
  const redirect = new Response(null, { status: 302 });
  assert.throws(() => toErrorResponse(redirect), (thrown) => thrown === redirect, "auth redirects pass through");
  assert.throws(() => assertId("../../etc/passwd"), (thrown) => thrown instanceof Response && thrown.status === 404);
  assert.equal(assertId("clxyz1234567890abc"), "clxyz1234567890abc");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { createShopifyGateway, fetchShopCurrency, fetchVariantNames, isThrottled } from "../app/services/shopify-gateway.server.ts";

type Handler = (query: string, variables: Record<string, unknown>) => unknown;

function fakeAdmin(handler: Handler) {
  const calls: { op: string; variables: Record<string, unknown> }[] = [];
  return {
    calls,
    admin: {
      async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
        const op = /(query|mutation) (\w+)/.exec(query)?.[2] ?? "unknown";
        const variables = options?.variables ?? {};
        calls.push({ op, variables });
        const result = handler(op, variables);
        if (result instanceof Error) throw result;
        return new Response(JSON.stringify({ data: result }));
      },
    } as unknown as Pick<AdminApiContext, "graphql">,
  };
}

const throttledError = () =>
  Object.assign(new Error("Throttled"), {
    body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } },
  });

const noSleep = async () => {};

test("detects THROTTLED GraphQL errors", () => {
  assert.ok(isThrottled(throttledError()));
  assert.ok(!isThrottled(new Error("Field 'x' doesn't exist")));
});

test("paginates product variants and stops past the cap", async () => {
  const pages: Record<string, { nodes: { id: string; price: string; compareAtPrice: string | null }[]; next: string | null }> = {
    start: { nodes: [{ id: "v1", price: "10.00", compareAtPrice: null }, { id: "v2", price: "12.00", compareAtPrice: "15.00" }], next: "c1" },
    c1: { nodes: [{ id: "v3", price: "9.00", compareAtPrice: null }], next: null },
  };
  const { admin, calls } = fakeAdmin((op, vars) => {
    assert.equal(op, "PriceTideProductVariants");
    const page = pages[(vars.after as string | null) ?? "start"];
    return {
      product: { variants: { nodes: page.nodes, pageInfo: { hasNextPage: page.next !== null, endCursor: page.next } } },
    };
  });
  const gateway = createShopifyGateway(admin, "s.myshopify.com", { sleep: noSleep });
  const all = await gateway.listTargetVariants("PRODUCTS", ["p1"], 100);
  assert.deepEqual(all.map((v) => v.id), ["v1", "v2", "v3"]);
  assert.equal(all[1].compareAtPrice, "15.00");
  assert.equal(all[0].productId, "p1");
  assert.equal(calls.length, 2);

  const capped = await createShopifyGateway(admin, "s", { sleep: noSleep }).listTargetVariants("PRODUCTS", ["p1", "p2"], 1);
  assert.ok(capped.length > 1, "returns cap+1 so the caller can detect the overflow");
});

test("expands collections into unique products", async () => {
  const { admin } = fakeAdmin((op, vars) => {
    if (op === "PriceTideCollectionProducts") {
      const products = vars.id === "c1" ? [{ id: "p1" }, { id: "p2" }] : [{ id: "p2" }];
      return { collection: { products: { nodes: products, pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return {
      product: {
        variants: {
          nodes: [{ id: `${vars.id}-v`, price: "5.00", compareAtPrice: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  });
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  const variants = await gateway.listTargetVariants("COLLECTIONS", ["c1", "c2"], 100);
  assert.deepEqual(variants.map((v) => v.id), ["p1-v", "p2-v"]);
});

// Regression (QA PT-07): drafts and archived products in a collection must not be put on sale.
test("collections leave out draft and archived products but keep ones picked directly", async () => {
  const { admin, calls } = fakeAdmin((op, vars) => {
    if (op === "PriceTideCollectionProducts") {
      const products = [
        { id: "p1", status: "ACTIVE" },
        { id: "p2", status: "ARCHIVED" },
        { id: "p3", status: "DRAFT" },
      ];
      return { collection: { products: { nodes: products, pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    return {
      product: {
        variants: {
          nodes: [{ id: `${vars.id}-v`, price: "5.00", compareAtPrice: null }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
  });
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  assert.deepEqual((await gateway.listTargetVariants("COLLECTIONS", ["c1"], 100)).map((v) => v.id), ["p1-v"]);
  assert.ok(calls.every((c) => c.op !== "PriceTideProductVariants" || c.variables.id === "p1"));
  assert.deepEqual((await gateway.listTargetVariants("PRODUCTS", ["p2"], 100)).map((v) => v.id), ["p2-v"]);
});

test("deleted products and variants are tolerated", async () => {
  const { admin } = fakeAdmin((op) =>
    op === "PriceTideProductVariants"
      ? { product: null }
      : { nodes: [null, { id: "v2", price: "3.00", compareAtPrice: null, product: { id: "p" } }] },
  );
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  assert.deepEqual(await gateway.listTargetVariants("PRODUCTS", ["gone"], 10), []);
  const prices = await gateway.getVariantPrices(["v1", "v2"]);
  assert.equal(prices.size, 1);
  assert.equal(prices.get("v2")?.price, "3.00");
});

test("variant lookups are batched", async () => {
  const { admin, calls } = fakeAdmin((_op, vars) => ({ nodes: (vars.ids as string[]).map(() => null) }));
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  await gateway.getVariantPrices(Array.from({ length: 250 }, (_, i) => `v${i}`));
  assert.deepEqual(calls.map((c) => (c.variables.ids as string[]).length), [100, 100, 50]);
});

test("bulk update maps partial userErrors back to the right variants", async () => {
  const { admin, calls } = fakeAdmin(() => ({
    productVariantsBulkUpdate: {
      productVariants: [{ id: "v1" }, { id: "v3" }],
      userErrors: [{ field: ["variants", "1", "price"], message: "Price must be greater than 0" }],
    },
  }));
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  const result = await gateway.updateVariantPrices("p", [
    { id: "v1", price: "8.00", compareAtPrice: "10.00" },
    { id: "v2", price: "0.00", compareAtPrice: "1.00" },
    { id: "v3", price: "4.00", compareAtPrice: null },
  ]);
  assert.deepEqual(result.updated, ["v1", "v3"]);
  assert.deepEqual(result.failed, [{ id: "v2", message: "Price must be greater than 0" }]);
  // compareAtPrice null is sent explicitly so Shopify clears it on revert.
  const sent = calls[0].variables.variants as { compareAtPrice: string | null }[];
  assert.equal(sent[2].compareAtPrice, null);
});

test("unconfirmed updates are treated as failures, never as success", async () => {
  const { admin } = fakeAdmin(() => ({ productVariantsBulkUpdate: null }));
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  const result = await gateway.updateVariantPrices("p", [{ id: "v1", price: "1.00", compareAtPrice: null }]);
  assert.deepEqual(result.updated, []);
  assert.equal(result.failed.length, 1);
});

test("throttled calls back off and retry; other errors surface", async () => {
  let n = 0;
  const waits: number[] = [];
  const { admin } = fakeAdmin(() => {
    n += 1;
    return n <= 2 ? throttledError() : { shop: { currencyCode: "EUR" } };
  });
  const gateway = createShopifyGateway(admin, "s", { sleep: async (ms) => void waits.push(ms) });
  assert.equal(await gateway.getShopCurrency(), "EUR");
  assert.deepEqual(waits, [1000, 2000]);

  const failing = createShopifyGateway(fakeAdmin(() => new Error("Access denied")).admin, "s", { sleep: noSleep });
  await assert.rejects(failing.getShopCurrency(), /Access denied/);

  const alwaysThrottled = createShopifyGateway(fakeAdmin(() => throttledError()).admin, "s", { sleep: noSleep });
  await assert.rejects(alwaysThrottled.getShopCurrency(), /Throttled/);
});

// Regression (QA PT-15, PT-16): screens look up names and currency, and survive a failed lookup.
test("variant names and shop currency are looked up, and failures are tolerated", async () => {
  const { admin } = fakeAdmin((op) =>
    op === "PriceTideVariantNames"
      ? { nodes: [{ id: "v1", displayName: "Snowboard - Blue" }, null, { id: "v3" }] }
      : { shop: { currencyCode: "EUR" } },
  );
  const names = await fetchVariantNames(admin, "s", ["v1", "v2", "v3"]);
  assert.deepEqual([...names], [["v1", "Snowboard - Blue"]]);
  assert.equal(await fetchShopCurrency(admin, "s"), "EUR");

  const { admin: broken } = fakeAdmin(() => new Error("boom"));
  assert.equal((await fetchVariantNames(broken, "s", ["v1"])).size, 0);
  assert.equal(await fetchShopCurrency(broken, "s"), null);
});

// Regression (code review): the compare-at-only cleanup must not send a price, or it could overwrite a fresh edit.
test("an update without a price leaves the price out of the request", async () => {
  const { admin, calls } = fakeAdmin(() => ({ productVariantsBulkUpdate: { productVariants: [{ id: "v1" }, { id: "v2" }], userErrors: [] } }));
  const gateway = createShopifyGateway(admin, "s", { sleep: noSleep });
  await gateway.updateVariantPrices("p1", [
    { id: "v1", compareAtPrice: null },
    { id: "v2", price: "9.00", compareAtPrice: "12.00" },
  ]);
  const sent = calls[0].variables.variants as Record<string, unknown>[];
  assert.equal("price" in sent[0], false);
  assert.equal(sent[1].price, "9.00");
});

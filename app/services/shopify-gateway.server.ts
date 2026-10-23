import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { logger } from "../lib/logger.ts";
import type { AdminGateway, UpdateResult, VariantPrice, VariantUpdate } from "../lib/sale-types.ts";
import type { TargetType } from "../lib/validation.ts";

/**
 * Admin GraphQL implementation of the engine's AdminGateway.
 *
 * Query costs are kept well under Shopify's 1,000-point single-query limit and
 * THROTTLED responses are retried with backoff. Network errors and 429/5xx are
 * retried by the client itself (`tries`).
 */

const MAX_THROTTLE_RETRIES = 6;
const VARIANT_PAGE = 250;
const PRODUCT_PAGE = 250;
const NODES_PAGE = 100;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface GraphqlErrorLike {
  message?: string;
  body?: { errors?: { graphQLErrors?: { extensions?: { code?: string } }[] } };
}

export function isThrottled(error: unknown): boolean {
  const e = error as GraphqlErrorLike | undefined;
  if (e?.body?.errors?.graphQLErrors?.some((g) => g?.extensions?.code === "THROTTLED")) return true;
  return typeof e?.message === "string" && /throttled/i.test(e.message);
}

export function createShopifyGateway(
  admin: Pick<AdminApiContext, "graphql">,
  shop: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): AdminGateway {
  const sleep = options.sleep ?? defaultSleep;
  async function query<T>(operation: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await admin.graphql(operation, { variables, tries: 3 });
        const json = (await response.json()) as unknown as { data?: T };
        if (!json.data) throw new Error("Shopify returned no data");
        return json.data;
      } catch (error) {
        if (isThrottled(error) && attempt < MAX_THROTTLE_RETRIES) {
          const wait = Math.min(10_000, 1000 * 2 ** attempt);
          logger.warn("Shopify API throttled, backing off", { shop, waitMs: wait });
          await sleep(wait);
          continue;
        }
        throw error;
      }
    }
  }

  async function variantsOfProduct(productId: string, out: VariantPrice[], cap: number): Promise<void> {
    let after: string | null = null;
    do {
      const data: {
        product: {
          variants: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { id: string; price: string; compareAtPrice: string | null }[];
          };
        } | null;
      } = await query(
        `#graphql
        query PriceTideProductVariants($id: ID!, $after: String) {
          product(id: $id) {
            variants(first: ${VARIANT_PAGE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id price compareAtPrice }
            }
          }
        }`,
        { id: productId, after },
      );
      if (!data.product) return; // deleted since it was selected
      for (const v of data.product.variants.nodes) {
        out.push({ id: v.id, productId, price: v.price, compareAtPrice: v.compareAtPrice });
      }
      if (out.length > cap) return;
      after = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
    } while (after);
  }

  async function productsOfCollection(collectionId: string, out: Set<string>, cap: number): Promise<void> {
    let after: string | null = null;
    do {
      const data: {
        collection: {
          products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string }[] };
        } | null;
      } = await query(
        `#graphql
        query PriceTideCollectionProducts($id: ID!, $after: String) {
          collection(id: $id) {
            products(first: ${PRODUCT_PAGE}, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id }
            }
          }
        }`,
        { id: collectionId, after },
      );
      if (!data.collection) return;
      for (const p of data.collection.products.nodes) out.add(p.id);
      if (out.size > cap) return;
      after = data.collection.products.pageInfo.hasNextPage ? data.collection.products.pageInfo.endCursor : null;
    } while (after);
  }

  return {
    async getShopCurrency() {
      const data = await query<{ shop: { currencyCode: string } }>(
        `#graphql
        query PriceTideShopCurrency { shop { currencyCode } }`,
      );
      return data.shop.currencyCode;
    },

    async listTargetVariants(targetType: TargetType, ids: string[], cap: number) {
      let productIds: string[] = ids;
      if (targetType === "COLLECTIONS") {
        const set = new Set<string>();
        for (const id of ids) {
          await productsOfCollection(id, set, cap);
          if (set.size > cap) break;
        }
        productIds = [...set];
      }
      const out: VariantPrice[] = [];
      for (const productId of productIds) {
        await variantsOfProduct(productId, out, cap);
        if (out.length > cap) break;
      }
      return out;
    },

    async getVariantPrices(variantIds: string[]) {
      const result = new Map<string, VariantPrice>();
      for (let i = 0; i < variantIds.length; i += NODES_PAGE) {
        const data = await query<{
          nodes: ({ id: string; price: string; compareAtPrice: string | null; product: { id: string } } | null)[];
        }>(
          `#graphql
          query PriceTideVariantPrices($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant { id price compareAtPrice product { id } }
            }
          }`,
          { ids: variantIds.slice(i, i + NODES_PAGE) },
        );
        for (const node of data.nodes) {
          if (node && node.id && node.price !== undefined) {
            result.set(node.id, {
              id: node.id,
              productId: node.product.id,
              price: node.price,
              compareAtPrice: node.compareAtPrice,
            });
          }
        }
      }
      return result;
    },

    async updateVariantPrices(productId: string, updates: VariantUpdate[]): Promise<UpdateResult> {
      const data = await query<{
        productVariantsBulkUpdate: {
          productVariants: { id: string }[] | null;
          userErrors: { field: string[] | null; message: string }[];
        } | null;
      }>(
        `#graphql
        mutation PriceTideUpdatePrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
            productVariants { id }
            userErrors { field message }
          }
        }`,
        {
          productId,
          variants: updates.map((u) => ({ id: u.id, price: u.price, compareAtPrice: u.compareAtPrice })),
        },
      );

      const payload = data.productVariantsBulkUpdate;
      const requested = new Set(updates.map((u) => u.id));
      const updated = (payload?.productVariants ?? []).map((v) => v.id).filter((id) => requested.has(id));
      const updatedSet = new Set(updated);

      // userErrors.field looks like ["variants", "3", "price"]: map the index back to a variant.
      const messages = new Map<string, string>();
      for (const err of payload?.userErrors ?? []) {
        const index = Number(err.field?.[1]);
        const id = Number.isInteger(index) ? updates[index]?.id : undefined;
        if (id) messages.set(id, err.message);
      }
      const fallback = payload?.userErrors?.[0]?.message ?? "Shopify did not confirm the update";
      const failed = updates
        .filter((u) => !updatedSet.has(u.id))
        .map((u) => ({ id: u.id, message: messages.get(u.id) ?? fallback }));

      return { updated, failed };
    },
  };
}

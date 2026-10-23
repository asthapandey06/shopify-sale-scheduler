import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { logger } from "../lib/logger";

/**
 * Development stores (including the ones Shopify's app reviewers use) can only
 * accept test charges. Reads the shop's plan from Shopify and stores the flag.
 * Returns the stored value if Shopify can't be reached.
 */
export async function refreshDevStoreFlag(admin: Pick<AdminApiContext, "graphql">, shop: string): Promise<boolean> {
  try {
    const response = await admin.graphql(
      `#graphql
      query SaleSchedulerShopPlan { shop { plan { partnerDevelopment } } }`,
    );
    const json = (await response.json()) as unknown as {
      data?: { shop?: { plan?: { partnerDevelopment?: boolean } } };
    };
    const isDevStore = json.data?.shop?.plan?.partnerDevelopment === true;
    await prisma.shop.upsert({ where: { shop }, create: { shop, isDevStore }, update: { isDevStore } });
    return isDevStore;
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.warn("Could not read shop plan", { shop, error: (error as Error).message });
    const row = await prisma.shop.findUnique({ where: { shop }, select: { isDevStore: true } });
    return row?.isDevStore ?? false;
  }
}

import { unauthenticated } from "../shopify.server";
import { logger } from "../lib/logger";

/**
 * Asks Shopify whether PriceTide is installed on the shop right now: the stored offline token only
 * works while the app is installed (uninstalling revokes it). Used to ignore uninstall/redact webhooks
 * that arrive after the merchant reinstalled. Any failure counts as "not installed", which is the
 * behaviour these webhooks had before this check.
 */
export async function isAppInstalled(shop: string): Promise<boolean> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(`#graphql
      query PriceTideInstallCheck { shop { id } }`);
    const json = (await response.json()) as { data?: { shop?: { id?: string } } };
    return Boolean(json.data?.shop?.id);
  } catch (error) {
    logger.info("Install check: app not reachable for shop", {
      shop,
      error: error instanceof Error ? error.message : "non-error response",
    });
    return false;
  }
}

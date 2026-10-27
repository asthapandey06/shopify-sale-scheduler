import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { redactShop } from "../services/sales.server";
import { isAppInstalled } from "../services/install-check.server";
import { logger } from "../lib/logger";

/**
 * Sent 48 hours after uninstall: erase everything stored for the shop. HMAC-verified and idempotent.
 * Skipped only if Shopify confirms the merchant has reinstalled the app meanwhile.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  const erased = await redactShop(shop, () => isAppInstalled(shop));
  logger.info(erased ? "Shop data erased" : "Shop data kept: app is installed again", { topic, shop, webhookId });
  return new Response();
};

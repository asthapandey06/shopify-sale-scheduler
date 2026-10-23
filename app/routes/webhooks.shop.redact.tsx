import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShopData } from "../services/sales.server";
import { logger } from "../lib/logger";

/** Sent 48 hours after uninstall: erase everything stored for the shop. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  await purgeShopData(shop);
  logger.info("Shop data erased", { topic, shop, webhookId });
  return new Response();
};

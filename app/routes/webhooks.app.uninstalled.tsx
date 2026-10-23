import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleUninstall } from "../services/sales.server";
import { logger } from "../lib/logger";

/**
 * HMAC-verified by authenticate.webhook (invalid signatures get a 401).
 * May be delivered more than once; handleUninstall is idempotent.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  logger.info("Webhook received", { topic, shop, webhookId });
  await handleUninstall(shop);
  return new Response();
};

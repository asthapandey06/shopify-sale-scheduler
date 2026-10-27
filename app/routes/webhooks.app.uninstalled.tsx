import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { handleUninstall } from "../services/sales.server";
import { logger } from "../lib/logger";

/**
 * HMAC-verified by authenticate.webhook (invalid signatures get a 401).
 * May be delivered more than once, and a retry can arrive after the merchant reinstalled: handleUninstall
 * is idempotent and ignores events triggered before the latest install.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const triggeredHeader = request.headers.get("X-Shopify-Triggered-At");
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  const triggeredAt = triggeredHeader ? new Date(triggeredHeader) : undefined;
  const applied = await handleUninstall(
    shop,
    triggeredAt && !Number.isNaN(triggeredAt.getTime()) ? triggeredAt : undefined,
  );
  logger.info("Webhook received", { topic, shop, webhookId, applied });
  return new Response();
};

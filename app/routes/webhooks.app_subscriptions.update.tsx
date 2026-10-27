import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger";
import { PLAN } from "../config.server";
import { applySubscriptionUpdate } from "../services/sales.server";

/**
 * HMAC-verified by authenticate.webhook. Keeps the stored plan status current; the payload is only a
 * hint and the subscription status is the source of truth. Idempotent (a plain status overwrite).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);
  const status = await applySubscriptionUpdate(shop, payload, PLAN);
  logger.info("Webhook received", { topic, shop, webhookId, status });
  return new Response();
};

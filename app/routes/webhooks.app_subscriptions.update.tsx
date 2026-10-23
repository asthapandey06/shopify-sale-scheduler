import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../lib/logger";
import { PLAN } from "../config.server";

/**
 * Keeps the stored plan status current when a subscription is approved,
 * cancelled, frozen (unpaid) or expires, so the background worker never starts
 * a sale for a shop that isn't paying. The payload is only a hint; the
 * subscription status is the source of truth.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } = await authenticate.webhook(request);
  const sub = (payload as { app_subscription?: { name?: unknown; status?: unknown } }).app_subscription;
  const status = typeof sub?.status === "string" ? sub.status.toUpperCase() : "";
  const name = typeof sub?.name === "string" ? sub.name : null;
  logger.info("Webhook received", { topic, shop, webhookId, status });

  if (name === PLAN && status) {
    await db.shop.updateMany({
      where: { shop },
      data: { billingActive: status === "ACTIVE", planName: status === "ACTIVE" ? name : null },
    });
  }
  return new Response();
};

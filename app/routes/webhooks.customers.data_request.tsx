import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger";

/**
 * Mandatory privacy webhook. This app stores no customer data (only product
 * variant prices), so there is nothing to export. The request is logged for
 * the compliance record.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  logger.info("Privacy webhook received; no customer data is stored", { topic, shop, webhookId });
  return new Response();
};

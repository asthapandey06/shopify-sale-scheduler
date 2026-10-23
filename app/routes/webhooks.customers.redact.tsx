import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger";

/** Mandatory privacy webhook. No customer data is stored, so nothing to erase. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);
  logger.info("Privacy webhook received; no customer data is stored", { topic, shop, webhookId });
  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../lib/logger";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop, webhookId } = await authenticate.webhook(request);
  logger.info("Webhook received", { topic, shop, webhookId });

  const current = Array.isArray(payload.current) ? (payload.current as unknown[]).filter((s) => typeof s === "string") : [];
  if (session) {
    await db.session.update({
      where: { id: session.id },
      data: { scope: current.join(",") },
    });
  }
  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import { config } from "../config.server";
import { safeEqual } from "../lib/crypto";
import { createRateLimiter } from "../lib/rate-limit";
import { runRetentionPurge, runTick } from "../services/scheduler.server";

/**
 * POST /jobs/tick — runs one scheduler pass. For hosts without long-running
 * processes (set SCHEDULER_ENABLED=false and call this every minute from a
 * cron service). Requires `Authorization: Bearer <CRON_SECRET>`.
 * Disabled (404) when CRON_SECRET is not configured.
 */

const limiter = createRateLimiter({ capacity: 10, refillPerMinute: 10 });

export const loader = async () => new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!config.cronSecret) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !safeEqual(token, config.cronSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!limiter.take("cron")) return new Response("Too many requests", { status: 429 });

  const result = await runTick();
  const purgedShops = await runRetentionPurge();
  return Response.json(
    { ok: result !== null, ...(result ?? {}), purgedShops },
    { headers: { "Cache-Control": "no-store" } },
  );
};

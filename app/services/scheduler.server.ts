import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { config } from "../config.server";
import { logger } from "../lib/logger";
import { createSaleEngine } from "../lib/sale-engine";
import { createTickRunner, type TickRunner } from "../lib/tick-runner";
import type { TickResult } from "../lib/sale-engine";
import { unauthenticated } from "../shopify.server";
import { createPrismaSaleRepo } from "./sale-repo.server";
import { createShopifyGateway } from "./shopify-gateway.server";
import { purgeUninstalledShops } from "./sales.server";

/** Data of uninstalled shops is erased after this, even if Shopify's shop/redact never arrives. */
const RETENTION_MS = 30 * 86_400_000;
const PURGE_INTERVAL_MS = 60 * 60_000;

/** Retention safety net; failures are logged and retried on the next run. */
export async function runRetentionPurge(): Promise<number> {
  try {
    return await purgeUninstalledShops(new Date(Date.now() - RETENTION_MS));
  } catch (error) {
    logger.error("Retention purge failed", { error: (error as Error).message });
    return 0;
  }
}

/**
 * Background worker that starts and ends sales on time.
 *
 * Runs inside the web process on an interval. Safe with any number of
 * instances: the per-shop lease in the database serializes work per shop.
 * For serverless hosts, disable it (SCHEDULER_ENABLED=false) and call
 * POST /jobs/tick from a cron service instead.
 */

interface SchedulerState {
  runner: TickRunner;
  timer: ReturnType<typeof setInterval> | null;
  purgeTimer: ReturnType<typeof setInterval> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var saleSchedulerGlobal: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.saleSchedulerGlobal) {
    const engine = createSaleEngine({
      repo: createPrismaSaleRepo(),
      gateway: async (shop) => {
        const { admin } = await unauthenticated.admin(shop);
        return createShopifyGateway(admin, shop);
      },
      now: () => new Date(),
      logger,
      owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
      maxVariantsPerSale: config.limits.maxVariantsPerSale,
    });
    globalThis.saleSchedulerGlobal = { runner: createTickRunner(() => engine.tick(), logger), timer: null, purgeTimer: null };
  }
  return globalThis.saleSchedulerGlobal;
}

/** Runs one pass unless one is already in progress in this process. */
export function runTick(): Promise<TickResult | null> {
  return getState().runner.runTick();
}

/** Fire-and-forget pass, used right after a merchant starts or ends a sale. */
export function kickScheduler(): void {
  if (!config.schedulerEnabled) return;
  setTimeout(() => void runTick(), 250).unref?.();
}

export function startScheduler(): void {
  const state = getState();
  if (state.timer) return;
  state.timer = setInterval(() => void runTick(), config.schedulerIntervalMs);
  state.timer.unref?.();
  state.purgeTimer = setInterval(() => void runRetentionPurge(), PURGE_INTERVAL_MS);
  state.purgeTimer.unref?.();
  logger.info("PriceTide scheduler started", { intervalMs: config.schedulerIntervalMs });

  const shutdown = async (signal: string) => {
    if (state.timer) clearInterval(state.timer);
    if (state.purgeTimer) clearInterval(state.purgeTimer);
    state.timer = null;
    state.purgeTimer = null;
    logger.info("Scheduler stopping; waiting for current pass", { signal });
    // Let an in-flight pass finish so shop leases are released cleanly.
    const finished = await state.runner.stop(20_000);
    if (!finished) logger.warn("Scheduler pass still running at shutdown; its leases expire on their own");
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

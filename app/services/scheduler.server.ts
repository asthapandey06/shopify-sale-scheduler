import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { config } from "../config.server";
import { logger } from "../lib/logger";
import { createSaleEngine, type SaleEngine, type TickResult } from "../lib/sale-engine";
import { unauthenticated } from "../shopify.server";
import { createPrismaSaleRepo } from "./sale-repo.server";
import { createShopifyGateway } from "./shopify-gateway.server";

/**
 * Background worker that starts and ends sales on time.
 *
 * Runs inside the web process on an interval. Safe with any number of
 * instances: the per-shop lease in the database serializes work per shop.
 * For serverless hosts, disable it (SCHEDULER_ENABLED=false) and call
 * POST /jobs/tick from a cron service instead.
 */

interface SchedulerState {
  engine: SaleEngine;
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<TickResult | null> | null;
  stopping: boolean;
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
    globalThis.saleSchedulerGlobal = { engine, timer: null, running: null, stopping: false };
  }
  return globalThis.saleSchedulerGlobal;
}

/** Runs one pass unless one is already in progress in this process. */
export function runTick(): Promise<TickResult | null> {
  const state = getState();
  if (state.stopping) return Promise.resolve(null);
  if (state.running) return state.running;
  state.running = state.engine
    .tick()
    .then((result) => {
      if (result.processed || result.errors) logger.info("Scheduler pass finished", { ...result });
      return result;
    })
    .catch((error: unknown) => {
      logger.error("Scheduler pass failed", { error: (error as Error).message });
      return null;
    })
    .finally(() => {
      state.running = null;
    });
  return state.running;
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
  logger.info("PriceTide scheduler started", { intervalMs: config.schedulerIntervalMs });

  const shutdown = async (signal: string) => {
    state.stopping = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    logger.info("Scheduler stopping; waiting for current pass", { signal });
    // Let an in-flight pass finish so shop leases are released cleanly.
    await Promise.race([state.running, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

import type { Logger } from "./logger.ts";
import type { TickResult } from "./sale-engine.ts";

export interface TickRunner {
  /** Runs one pass unless one is already in progress in this process (then returns that one). */
  runTick(): Promise<TickResult | null>;
  /**
   * Stops new passes and waits for the in-flight one (it releases its shop leases when it finishes),
   * at most `timeoutMs`. Returns true if the pass finished in time.
   */
  stop(timeoutMs: number): Promise<boolean>;
  readonly stopping: boolean;
}

/** Coalesces scheduler passes within one process. Safe across processes because of the per-shop lease. */
export function createTickRunner(tick: () => Promise<TickResult>, logger: Logger): TickRunner {
  let running: Promise<TickResult | null> | null = null;
  let stopping = false;

  return {
    runTick() {
      if (stopping) return Promise.resolve(null);
      if (running) return running;
      running = tick()
        .then((result) => {
          if (result.processed || result.errors) logger.info("Scheduler pass finished", { ...result });
          return result;
        })
        .catch((error: unknown) => {
          logger.error("Scheduler pass failed", { error: (error as Error).message });
          return null;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },

    async stop(timeoutMs) {
      stopping = true;
      if (!running) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const finished = await Promise.race([running.then(() => true as const), timedOut]);
      clearTimeout(timer);
      return finished;
    },

    get stopping() {
      return stopping;
    },
  };
}

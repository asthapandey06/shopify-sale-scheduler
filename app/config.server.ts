import { loadConfig, type AppConfig } from "./lib/env";

declare global {
  // eslint-disable-next-line no-var
  var appConfigGlobal: AppConfig | undefined;
}

/** Validated configuration. Throws at boot with every problem listed. */
export const config: AppConfig = globalThis.appConfigGlobal ?? loadConfig(process.env);
globalThis.appConfigGlobal = config;

export const PLAN = config.billing.planName;

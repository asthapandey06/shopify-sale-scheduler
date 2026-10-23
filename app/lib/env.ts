import { parseKeyring, type Keyring } from "./crypto.ts";

/**
 * Validates configuration once at boot so the app fails fast with a clear
 * message instead of misbehaving at runtime.
 */

export interface AppConfig {
  isProduction: boolean;
  apiKey: string;
  apiSecret: string;
  appUrl: string;
  scopes: string[];
  keyring: Keyring;
  cronSecret: string | null;
  /** Public support/privacy contact shown on /privacy. */
  supportEmail: string;
  /** Legal name of the app owner shown on /privacy. */
  ownerName: string;
  schedulerEnabled: boolean;
  schedulerIntervalMs: number;
  billing: {
    planName: string;
    amount: number;
    currencyCode: string;
    trialDays: number;
    testMode: boolean;
  };
  limits: {
    maxVariantsPerSale: number;
    maxLiveSalesPerShop: number;
  };
}

function intInRange(raw: string | undefined, fallback: number, min: number, max: number, name: string, errors: string[]): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${name} must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return value;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const errors: string[] = [];
  const isProduction = env.NODE_ENV === "production";

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) errors.push(`${name} is required`);
    return value ?? "";
  };

  const apiKey = required("SHOPIFY_API_KEY");
  const apiSecret = required("SHOPIFY_API_SECRET");
  const appUrl = required("SHOPIFY_APP_URL");
  required("DATABASE_URL");

  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (isProduction && url.protocol !== "https:") errors.push("SHOPIFY_APP_URL must use https in production");
    } catch {
      errors.push("SHOPIFY_APP_URL must be a valid URL");
    }
  }

  const scopes = (env.SCOPES ?? "write_products")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedScopes = new Set(["write_products", "read_products"]);
  for (const scope of scopes) {
    if (!allowedScopes.has(scope)) errors.push(`Scope "${scope}" is not needed by this app; remove it (least privilege)`);
  }

  let keyring: Keyring = { activeKeyId: "", keys: new Map() };
  try {
    keyring = parseKeyring(env.TOKEN_ENCRYPTION_KEYS);
  } catch (error) {
    errors.push((error as Error).message);
  }

  const cronSecret = env.CRON_SECRET?.trim() || null;
  if (cronSecret && cronSecret.length < 32) errors.push("CRON_SECRET must be at least 32 characters");

  const supportEmail = env.SUPPORT_EMAIL?.trim() ?? "";
  if (isProduction && !supportEmail) errors.push("SUPPORT_EMAIL is required in production (shown in the privacy policy)");
  if (supportEmail && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(supportEmail)) errors.push("SUPPORT_EMAIL must be an email address");

  const amount = Number(env.PLAN_PRICE ?? "9.99");
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) errors.push("PLAN_PRICE must be a positive number");

  const testMode = bool(env.BILLING_TEST_MODE, !isProduction);

  const config: AppConfig = {
    isProduction,
    apiKey,
    apiSecret,
    appUrl,
    scopes,
    keyring,
    cronSecret,
    supportEmail,
    ownerName: env.APP_OWNER_NAME?.trim() || "the app developer",
    schedulerEnabled: bool(env.SCHEDULER_ENABLED, true),
    schedulerIntervalMs: intInRange(env.SCHEDULER_INTERVAL_SECONDS, 30, 10, 3600, "SCHEDULER_INTERVAL_SECONDS", errors) * 1000,
    billing: {
      planName: "Pro",
      amount,
      currencyCode: "USD",
      trialDays: intInRange(env.TRIAL_DAYS, 7, 0, 60, "TRIAL_DAYS", errors),
      testMode,
    },
    limits: {
      maxVariantsPerSale: intInRange(env.MAX_VARIANTS_PER_SALE, 5000, 1, 50_000, "MAX_VARIANTS_PER_SALE", errors),
      maxLiveSalesPerShop: intInRange(env.MAX_LIVE_SALES_PER_SHOP, 20, 1, 500, "MAX_LIVE_SALES_PER_SHOP", errors),
    },
  };

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
  }
  return config;
}

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

const TRUE_VALUES = ["1", "true", "yes", "on"];
const FALSE_VALUES = ["0", "false", "no", "off"];

/** Parses a yes/no setting; a typo is an error rather than silently "false". */
function bool(raw: string | undefined, fallback: boolean, name: string, errors: string[]): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  errors.push(`${name} must be true or false`);
  return fallback;
}

function isPostgresUrl(value: string): boolean {
  try {
    return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Hosts that only make sense during `shopify app dev`; a production app URL must be stable.
const DEV_HOST_RE = /(^|\.)(localhost|127\.0\.0\.1|trycloudflare\.com|ngrok(-free)?\.(app|io|dev))$/i;

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
  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl && !isPostgresUrl(databaseUrl)) errors.push("DATABASE_URL must be a postgres:// or postgresql:// URL");
  // Optional direct (non-pooled) connection for migrations, e.g. Neon's direct URL; see README.
  const directUrl = env.DIRECT_URL?.trim();
  if (directUrl && !isPostgresUrl(directUrl)) errors.push("DIRECT_URL must be a postgres:// or postgresql:// URL");

  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (isProduction && url.protocol !== "https:") errors.push("SHOPIFY_APP_URL must use https in production");
      if (isProduction && DEV_HOST_RE.test(url.hostname)) {
        errors.push("SHOPIFY_APP_URL points to a temporary development host; use your production domain");
      }
    } catch {
      errors.push("SHOPIFY_APP_URL must be a valid URL");
    }
  }

  const scopes = (env.SCOPES ?? "write_products")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedScopes = new Set(["write_products"]);
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

  // Off unless asked for: development stores get test charges via their detected dev-store flag.
  const testMode = bool(env.BILLING_TEST_MODE, false, "BILLING_TEST_MODE", errors);
  const schedulerEnabled = bool(env.SCHEDULER_ENABLED, true, "SCHEDULER_ENABLED", errors);
  if (isProduction && !schedulerEnabled && !cronSecret) {
    errors.push("SCHEDULER_ENABLED=false needs CRON_SECRET, so a cron service can run sales via POST /jobs/tick");
  }

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
    schedulerEnabled,
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

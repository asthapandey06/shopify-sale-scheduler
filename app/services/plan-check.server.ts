import { authenticate } from "../shopify.server";
import { PLAN } from "../config.server";
import { createTtlCache } from "../lib/ttl-cache";
import { isTestBillingShop, setBillingStatus } from "./sales.server";

type AdminBilling = Awaited<ReturnType<typeof authenticate.admin>>["billing"];
type PlanCheck = Awaited<ReturnType<AdminBilling["check"]>>;

/**
 * Every admin page load runs the layout loader and the page loader together, and each asked Shopify for the
 * subscription. One check is shared for a few seconds instead. The cache is per process, so it is only for
 * reads that tolerate a few seconds of delay: writes pass `fresh`. Test and live checks are cached apart,
 * because a dev store only sees its subscription through a test check.
 */
const cache = createTtlCache<PlanCheck>(10_000);
const generations = new Map<string, number>();

const keyFor = (shop: string, isTest: boolean) => `${shop}:${isTest ? "test" : "live"}`;
const generationOf = (shop: string) => generations.get(shop) ?? 0;

export function invalidatePlanCheck(shop: string): void {
  generations.set(shop, generationOf(shop) + 1);
  cache.invalidate(keyFor(shop, true));
  cache.invalidate(keyFor(shop, false));
}

export async function checkPlan(
  billing: AdminBilling,
  shop: string,
  options: { isTest?: boolean; fresh?: boolean } = {},
): Promise<PlanCheck> {
  const isTest = options.isTest ?? (await isTestBillingShop(shop));
  if (options.fresh) invalidatePlanCheck(shop);
  return cache.get(keyFor(shop, isTest), async () => {
    const generation = generationOf(shop);
    const check = await billing.check({ plans: [PLAN], isTest });
    // A webhook or action that changed the plan while this was in flight wins; don't overwrite it with older news.
    if (generation === generationOf(shop)) {
      await setBillingStatus(shop, check.hasActivePayment, check.appSubscriptions[0]?.name ?? null);
    }
    return check;
  });
}

import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { config, PLAN } from "../config.server";
import {
  HttpError,
  audit,
  countRunningSales,
  enforceRateLimit,
  isTestBillingShop,
  setBillingStatus,
} from "../services/sales.server";
import { toErrorResponse } from "../services/http.server";
import { refreshDevStoreFlag } from "../services/shop-plan.server";
import { formatMoney } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const isTest = config.billing.testMode || (await refreshDevStoreFlag(admin, session.shop));
  const check = await billing.check({ plans: [PLAN], isTest });
  const subscription = check.appSubscriptions[0];
  await setBillingStatus(session.shop, check.hasActivePayment, subscription?.name ?? null);

  return {
    hasPlan: check.hasActivePayment,
    isTest,
    subscription: subscription
      ? { name: subscription.name, status: subscription.status, test: subscription.test, trialDays: subscription.trialDays }
      : null,
    plan: {
      name: PLAN,
      price: formatMoney(config.billing.amount.toFixed(2), config.billing.currencyCode),
      trialDays: config.billing.trialDays,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session, billing } = await authenticate.admin(request);
    enforceRateLimit(session.shop);
    const intent = (await request.formData()).get("intent");
    const isTest = await isTestBillingShop(session.shop);

    if (intent === "subscribe") {
      await audit(session.shop, null, "billing.subscribe_requested");
      // Throws a redirect to Shopify's approval page.
      await billing.request({ plan: PLAN, isTest });
      return data({ ok: true as const, message: "Redirecting to Shopify…" });
    }

    if (intent === "cancel") {
      if ((await countRunningSales(session.shop)) > 0) {
        throw new HttpError(409, "End your running sales before cancelling, so prices can be restored.");
      }
      // Only cancel subscriptions Shopify says this shop owns; never trust an id from the client.
      const check = await billing.check({ plans: [PLAN], isTest });
      for (const subscription of check.appSubscriptions) {
        await billing.cancel({ subscriptionId: subscription.id, isTest, prorate: true });
      }
      await setBillingStatus(session.shop, false, null);
      await audit(session.shop, null, "billing.cancelled");
      return data({ ok: true as const, message: "Subscription cancelled" });
    }

    throw new HttpError(400, "Unknown action.");
  } catch (error) {
    return toErrorResponse(error, { route: "billing" });
  }
};

export default function Billing() {
  const { hasPlan, subscription, plan, isTest } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Plan">
      <s-section heading={`${plan.name} — ${plan.price} / 30 days`}>
        <s-stack gap="base">
          <s-unordered-list>
            <s-list-item>Unlimited scheduled sales (up to 20 at a time)</s-list-item>
            <s-list-item>Percentage or fixed-amount discounts with .99 / .95 rounding</s-list-item>
            <s-list-item>Exact original prices restored automatically, merchant edits respected</s-list-item>
            <s-list-item>Products or whole collections, up to 5,000 variants per sale</s-list-item>
          </s-unordered-list>

          {hasPlan && subscription ? (
            <s-stack gap="small-200">
              <s-banner tone="success" heading="You're subscribed">
                <s-paragraph>
                  Status: {subscription.status.toLowerCase()}
                  {subscription.test ? " (test charge — you won't be billed)" : ""}
                </s-paragraph>
              </s-banner>
              {confirmCancel ? (
                <s-banner tone="warning" heading="Cancel your subscription?">
                  <s-paragraph>You won&apos;t be able to schedule new sales without a plan.</s-paragraph>
                  <fetcher.Form method="post" onSubmit={() => setConfirmCancel(false)}>
                    <input type="hidden" name="intent" value="cancel" />
                    <s-stack direction="inline" gap="small-200">
                      <s-button type="submit" tone="critical" disabled={busy || undefined}>
                        Yes, cancel
                      </s-button>
                      <s-button onClick={() => setConfirmCancel(false)}>Keep my plan</s-button>
                    </s-stack>
                  </fetcher.Form>
                </s-banner>
              ) : (
                <s-button tone="critical" onClick={() => setConfirmCancel(true)}>
                  Cancel subscription
                </s-button>
              )}
            </s-stack>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="subscribe" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                {plan.trialDays > 0 ? `Start ${plan.trialDays}-day free trial` : "Subscribe"}
              </s-button>
            </fetcher.Form>
          )}

          {isTest && <s-text color="subdued">This is a development store, so charges are test charges.</s-text>}
          <s-text color="subdued">Billed by Shopify on your regular Shopify invoice. Cancel any time.</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

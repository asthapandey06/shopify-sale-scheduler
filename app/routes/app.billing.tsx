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
  deleteAllSaleData,
  enforceRateLimit,
  isShopPaused,
  isTestBillingShop,
  pauseShop,
  resumeShop,
  setBillingStatus,
} from "../services/sales.server";
import { kickScheduler } from "../services/scheduler.server";
import { toErrorResponse } from "../services/http.server";
import { refreshDevStoreFlag } from "../services/shop-plan.server";
import { formatMoney } from "../components/ui";
import { logger } from "../lib/logger";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, admin } = await authenticate.admin(request);
  const isTest = config.billing.testMode || (await refreshDevStoreFlag(admin, session.shop));
  const check = await billing.check({ plans: [PLAN], isTest });
  const subscription = check.appSubscriptions[0];
  await setBillingStatus(session.shop, check.hasActivePayment, subscription?.name ?? null);

  return {
    hasPlan: check.hasActivePayment,
    paused: await isShopPaused(session.shop),
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
    const form = await request.formData();
    const intent = form.get("intent");
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

    if (intent === "pause") {
      // Ends running sales (prices restored by the scheduler) and holds scheduled ones, then stops billing.
      const { endedSales } = await pauseShop(session.shop);
      try {
        const check = await billing.check({ plans: [PLAN], isTest });
        for (const subscription of check.appSubscriptions) {
          await billing.cancel({ subscriptionId: subscription.id, isTest, prorate: true });
        }
      } catch (error) {
        if (error instanceof Response) throw error;
        logger.error("Cancelling the plan while pausing failed", { shop: session.shop, error: error as Error });
        throw new HttpError(502, "PriceTide is paused, but cancelling your plan didn't work. Please try again.");
      }
      await setBillingStatus(session.shop, false, null);
      kickScheduler();
      return data({
        ok: true as const,
        message: endedSales > 0 ? "PriceTide paused. Restoring prices of running sales…" : "PriceTide paused",
      });
    }

    if (intent === "resume") {
      const check = await billing.check({ plans: [PLAN], isTest });
      if (!check.hasActivePayment) {
        // Still paused until a plan is approved: throws a redirect to Shopify's approval page, and the
        // merchant resumes from here once they're back with an active plan.
        await billing.request({ plan: PLAN, isTest });
      }
      await resumeShop(session.shop);
      kickScheduler();
      return data({ ok: true as const, message: "PriceTide resumed" });
    }

    if (intent === "delete-data") {
      if (form.get("confirm") !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
      const deleted = await deleteAllSaleData(session.shop);
      return data({ ok: true as const, message: `Deleted ${deleted} sale${deleted === 1 ? "" : "s"} and their history` });
    }

    throw new HttpError(400, "Unknown action.");
  } catch (error) {
    return toErrorResponse(error, { route: "billing" });
  }
};

export default function Billing() {
  const { hasPlan, paused, subscription, plan, isTest } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteText, setDeleteText] = useState("");

  useEffect(() => {
    if (fetcher.data) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="Plan">
      {paused && (
        <s-banner tone="info" heading="PriceTide is paused">
          <s-stack gap="small-200">
            <s-paragraph>
              Your scheduled sales are on hold and won&apos;t start. Your sales and history are kept.{" "}
              {hasPlan
                ? "Your plan is active: resume to let scheduled sales start again."
                : "To resume, choose a plan first, then come back here and resume."}{" "}
              Sales whose start time passed while paused are marked as missed.
            </s-paragraph>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="resume" />
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                {hasPlan ? "Resume PriceTide" : "Choose a plan to resume"}
              </s-button>
            </fetcher.Form>
          </s-stack>
        </s-banner>
      )}

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
          ) : paused ? null : (
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

      <s-section heading="Your data">
        <s-stack gap="base">
          <s-paragraph>
            Thinking of leaving? Choose what happens to your sales first. If you uninstall PriceTide, Shopify asks us
            to erase your data 48 hours later, and we erase it after 30 days at the latest, so it can&apos;t be
            restored after that. If you might come back, pause instead and keep the app installed.
          </s-paragraph>

          {/* Also offered while paused but still billed (e.g. cancelling the plan failed), to retry. */}
          {(!paused || hasPlan) &&
            (confirmPause ? (
              <s-banner tone="warning" heading="Pause PriceTide?">
                <s-stack gap="small-200">
                  <s-paragraph>
                    Running sales end now and their original prices are restored. Scheduled sales are kept but
                    won&apos;t start. Your subscription is cancelled, so you won&apos;t be charged. Your sales and
                    history stay here, and you can resume any time.
                  </s-paragraph>
                  <fetcher.Form method="post" onSubmit={() => setConfirmPause(false)}>
                    <input type="hidden" name="intent" value="pause" />
                    <s-stack direction="inline" gap="small-200">
                      <s-button type="submit" variant="primary" disabled={busy || undefined}>
                        Pause and cancel plan
                      </s-button>
                      <s-button onClick={() => setConfirmPause(false)}>Keep running</s-button>
                    </s-stack>
                  </fetcher.Form>
                </s-stack>
              </s-banner>
            ) : (
              <s-button onClick={() => setConfirmPause(true)}>Pause PriceTide (resume later)</s-button>
            ))}

          {confirmDelete ? (
            <s-banner tone="critical" heading="Permanently delete all your data?">
              <s-stack gap="small-200">
                <s-paragraph>
                  This deletes every sale and its history. It can&apos;t be undone and the data can&apos;t be
                  retrieved; you&apos;ll start fresh. Your current prices in Shopify are not changed. Sales that are
                  running or still have changed prices must be ended first.
                </s-paragraph>
                <fetcher.Form
                  method="post"
                  onSubmit={() => {
                    setConfirmDelete(false);
                    setDeleteText("");
                  }}
                >
                  <input type="hidden" name="intent" value="delete-data" />
                  <s-stack gap="small-200">
                    <s-text-field
                      label="Type DELETE to confirm"
                      name="confirm"
                      value={deleteText}
                      autocomplete="off"
                      onInput={(e) => setDeleteText(e.currentTarget.value)}
                    ></s-text-field>
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        type="submit"
                        tone="critical"
                        disabled={busy || deleteText !== "DELETE" || undefined}
                      >
                        Delete everything
                      </s-button>
                      <s-button
                        onClick={() => {
                          setConfirmDelete(false);
                          setDeleteText("");
                        }}
                      >
                        Keep my data
                      </s-button>
                    </s-stack>
                  </s-stack>
                </fetcher.Form>
              </s-stack>
            </s-banner>
          ) : (
            <s-button tone="critical" onClick={() => setConfirmDelete(true)}>
              Permanently delete my data
            </s-button>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

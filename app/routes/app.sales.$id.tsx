import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  HttpError,
  cancelSale,
  deleteSale,
  endSaleNow,
  enforceRateLimit,
  getSaleDetail,
  restoreSale,
} from "../services/sales.server";
import { assertId, toErrorResponse } from "../services/http.server";
import { kickScheduler } from "../services/scheduler.server";
import { ITEM_STATUS, type ItemStatus } from "../lib/sale-types";
import { LocalTime, ROUNDING_LABEL, StatusBadge, describeDiscount, formatMoney, gidNumber } from "../components/ui";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const id = assertId(params.id);
  const detail = await getSaleDetail(session.shop, id);
  if (!detail) throw new Response("Not found", { status: 404 });
  const { sale, statusCounts, items } = detail;

  return {
    sale: {
      id: sale.id,
      name: sale.name,
      status: sale.status,
      discount: describeDiscount(sale.discountType, sale.discountValue, sale.currencyCode),
      rounding: ROUNDING_LABEL[sale.rounding] ?? sale.rounding,
      targetType: sale.targetType,
      targets: sale.targets,
      startsAt: sale.startsAt.toISOString(),
      endsAt: sale.endsAt.toISOString(),
      currencyCode: sale.currencyCode,
      lastError: sale.lastError,
      nextAttemptAt: sale.nextAttemptAt?.toISOString() ?? null,
    },
    statusCounts,
    items,
  };
};

type Intent = "cancel" | "end" | "delete" | "restore";
const INTENTS: Intent[] = ["cancel", "end", "delete", "restore"];

export const action = async ({ request, params }: ActionFunctionArgs) => {
  try {
    const { session, redirect } = await authenticate.admin(request);
    enforceRateLimit(session.shop);
    const id = assertId(params.id);
    const form = await request.formData();
    const intent = form.get("intent");
    if (typeof intent !== "string" || !INTENTS.includes(intent as Intent)) {
      throw new HttpError(400, "Unknown action.");
    }

    switch (intent as Intent) {
      case "cancel":
        if (!(await cancelSale(session.shop, id))) throw new HttpError(409, "This sale has already started or ended.");
        return data({ ok: true as const, message: "Sale cancelled" });
      case "end":
        if (!(await endSaleNow(session.shop, id))) throw new HttpError(409, "This sale is not running.");
        kickScheduler();
        return data({ ok: true as const, message: "Ending sale and restoring prices" });
      case "restore":
        if (!(await restoreSale(session.shop, id))) throw new HttpError(409, "There are no changed prices to restore.");
        kickScheduler();
        return data({ ok: true as const, message: "Restoring original prices" });
      case "delete":
        if (!(await deleteSale(session.shop, id))) {
          throw new HttpError(409, "Only finished sales with no changed prices can be deleted.");
        }
        return redirect("/app");
    }
  } catch (error) {
    return toErrorResponse(error, { route: "sales.detail" });
  }
};

const ITEM_LABEL: Record<ItemStatus, string> = {
  PENDING: "Waiting",
  APPLIED: "On sale",
  REVERTED: "Restored",
  SKIPPED: "Skipped",
  CONFLICT: "Edited during sale",
  FAILED: "Failed",
};

const TRANSITIONAL = new Set(["ACTIVATING", "REVERTING"]);

export default function SaleDetail() {
  const { sale, statusCounts, items } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const result = fetcher.data ?? actionData;
  useEffect(() => {
    if (result) shopify.toast.show(result.message, { isError: !result.ok });
  }, [result, shopify]);

  // Poll while the worker is changing prices, or when a start/end time is near.
  useEffect(() => {
    const soon = (iso: string) => Math.abs(new Date(iso).getTime() - Date.now()) < 2 * 60_000;
    const shouldPoll =
      TRANSITIONAL.has(sale.status) ||
      (sale.status === "SCHEDULED" && soon(sale.startsAt)) ||
      (sale.status === "ACTIVE" && soon(sale.endsAt));
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [sale.status, sale.startsAt, sale.endsAt, revalidator]);

  // Inline confirmation (native confirm() dialogs are unreliable inside the admin iframe).
  const [confirming, setConfirming] = useState<{ intent: Intent; text: string } | null>(null);
  const act = (intent: Intent, confirmText?: string) => {
    if (confirmText) {
      setConfirming({ intent, text: confirmText });
      return;
    }
    setConfirming(null);
    fetcher.submit({ intent }, { method: "post" });
  };

  const applied = statusCounts[ITEM_STATUS.APPLIED] ?? 0;
  const total = Object.values(statusCounts).reduce((a, b) => a + (b ?? 0), 0);

  return (
    <s-page heading={sale.name}>
      <s-link slot="breadcrumb-actions" href="/app">
        Sales
      </s-link>

      {sale.status === "SCHEDULED" && (
        <s-button slot="secondary-actions" tone="critical" disabled={busy || undefined} onClick={() => act("cancel", "Cancel this sale? Prices will not change.")}>
          Cancel sale
        </s-button>
      )}
      {sale.status === "ACTIVE" && (
        <s-button slot="primary-action" variant="primary" disabled={busy || undefined} onClick={() => act("end", "End this sale now and restore original prices?")}>
          End sale now
        </s-button>
      )}
      {sale.status === "FAILED" && applied > 0 && (
        <s-button slot="primary-action" variant="primary" disabled={busy || undefined} onClick={() => act("restore")}>
          Restore original prices
        </s-button>
      )}
      {["COMPLETED", "CANCELLED", "FAILED"].includes(sale.status) && applied === 0 && (
        <s-button slot="secondary-actions" tone="critical" disabled={busy || undefined} onClick={() => act("delete", "Delete this sale and its history?")}>
          Delete
        </s-button>
      )}

      {confirming && (
        <s-banner tone="warning" heading="Please confirm">
          <s-paragraph>{confirming.text}</s-paragraph>
          <s-button slot="secondary-actions" variant="primary" onClick={() => act(confirming.intent)}>
            Yes, continue
          </s-button>
          <s-button slot="secondary-actions" onClick={() => setConfirming(null)}>
            Keep it
          </s-button>
        </s-banner>
      )}

      {sale.lastError && (
        <s-banner tone={sale.status === "FAILED" ? "critical" : "warning"} heading="Attention">
          <s-paragraph>{sale.lastError}</s-paragraph>
          {sale.nextAttemptAt && (
            <s-paragraph>
              Next attempt: <LocalTime iso={sale.nextAttemptAt} />
            </s-paragraph>
          )}
        </s-banner>
      )}

      <s-section heading="Summary">
        <s-stack gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <StatusBadge status={sale.status} />
            <s-text>{sale.discount}</s-text>
            <s-text color="subdued">· {sale.rounding}</s-text>
          </s-stack>
          <s-text>
            Starts <LocalTime iso={sale.startsAt} /> · Ends <LocalTime iso={sale.endsAt} />
          </s-text>
          <s-text color="subdued">
            {sale.targetType === "PRODUCTS" ? "Products" : "Collections"}:{" "}
            {sale.targets.slice(0, 5).map((t) => t.title).join(", ")}
            {sale.targets.length > 5 ? ` and ${sale.targets.length - 5} more` : ""}
          </s-text>
          {total > 0 && (
            <s-text color="subdued">
              {Object.entries(statusCounts)
                .map(([status, count]) => `${count} ${ITEM_LABEL[status as ItemStatus].toLowerCase()}`)
                .join(" · ")}
            </s-text>
          )}
        </s-stack>
      </s-section>

      {items.length > 0 && (
        <s-section heading="Variants" padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Variant</s-table-header>
              <s-table-header>Original</s-table-header>
              <s-table-header>Sale price</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {items.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>
                    <s-link href={`shopify://admin/products/${gidNumber(item.productId)}/variants/${gidNumber(item.variantId)}`} target="_top">
                      #{gidNumber(item.variantId)}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{formatMoney(item.originalPrice, sale.currencyCode)}</s-table-cell>
                  <s-table-cell>
                    {item.status === "SKIPPED" ? "—" : formatMoney(item.salePrice, sale.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {ITEM_LABEL[item.status as ItemStatus] ?? item.status}
                    {item.message ? <s-text color="subdued"> · {item.message}</s-text> : null}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {total > items.length && (
            <s-box padding="base">
              <s-text color="subdued">Showing the first {items.length} of {total} variants.</s-text>
            </s-box>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

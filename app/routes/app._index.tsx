import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { config, PLAN } from "../config.server";
import { ITEM_STATUS } from "../lib/sale-types";
import {
  countRunningSales,
  isShopPaused,
  isTestBillingShop,
  listSales,
  setBillingStatus,
} from "../services/sales.server";
import { LocalTime, StatusBadge, describeDiscount } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing, redirect } = await authenticate.admin(request);
  const shop = session.shop;

  // On install and reinstall, merchants without a plan go straight to the plan
  // page to approve (or decline) the charge (App Store requirement 1.2.2).
  // Exception: if prices are still changed by a sale, they must be able to reach it to restore them.
  const check = await billing.check({ plans: [PLAN], isTest: await isTestBillingShop(shop) });
  await setBillingStatus(shop, check.hasActivePayment, check.appSubscriptions[0]?.name ?? null);
  if (!check.hasActivePayment) {
    const changedPrices = await prisma.saleItem.count({ where: { shop, status: ITEM_STATUS.APPLIED } });
    if (changedPrices === 0) throw redirect("/app/billing");
  }

  const [sales, running, paused] = await Promise.all([listSales(shop), countRunningSales(shop), isShopPaused(shop)]);

  return {
    hasPlan: check.hasActivePayment,
    paused,
    running,
    trialDays: config.billing.trialDays,
    sales: sales.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      discount: describeDiscount(s.discountType, s.discountValue, s.currencyCode),
      targets: s.targets.length,
      targetType: s.targetType,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      lastError: s.lastError,
    })),
  };
};

export default function SalesIndex() {
  const { sales, hasPlan, paused, running, trialDays } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Scheduled sales">
      <s-button slot="primary-action" variant="primary" href="/app/sales/new">
        Create sale
      </s-button>

      {paused && (
        <s-banner tone="info" heading="PriceTide is paused">
          <s-paragraph>Scheduled sales are on hold. Running sales are ending and their prices are being restored.</s-paragraph>
          <s-button slot="secondary-actions" href="/app/billing">
            Resume
          </s-button>
        </s-banner>
      )}

      {!hasPlan && !paused && (
        <s-banner tone="warning" heading="Choose a plan to run sales">
          <s-paragraph>
            {trialDays > 0
              ? `Start your ${trialDays}-day free trial to schedule your first sale.`
              : "Subscribe to schedule sales."}
          </s-paragraph>
          <s-button slot="secondary-actions" href="/app/billing">
            View plan
          </s-button>
        </s-banner>
      )}

      {running > 0 && (
        <s-banner tone="info" heading="Sales are running">
          <s-paragraph>
            End running sales before uninstalling the app so original prices are restored. After uninstall, Shopify
            no longer lets the app change your prices.
          </s-paragraph>
        </s-banner>
      )}

      {sales.length === 0 ? (
        <s-section>
          <s-stack gap="base" alignItems="center">
            <s-heading>Schedule your first sale</s-heading>
            <s-paragraph>
              Pick products or collections, set a discount and a start and end time. Prices change automatically and
              go back to exactly what they were when the sale ends.
            </s-paragraph>
            <s-button variant="primary" href="/app/sales/new">
              Create sale
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Sale</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Starts</s-table-header>
              <s-table-header>Ends</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sales.map((sale) => (
                <s-table-row key={sale.id}>
                  <s-table-cell>
                    <s-link href={`/app/sales/${sale.id}`}>{sale.name}</s-link>
                    <s-text color="subdued">
                      {" "}
                      · {sale.targets} {sale.targetType === "PRODUCTS" ? "product" : "collection"}
                      {sale.targets === 1 ? "" : "s"}
                    </s-text>
                  </s-table-cell>
                  <s-table-cell>
                    <StatusBadge status={sale.status} />
                  </s-table-cell>
                  <s-table-cell>{sale.discount}</s-table-cell>
                  <s-table-cell>
                    <LocalTime iso={sale.startsAt} />
                  </s-table-cell>
                  <s-table-cell>
                    <LocalTime iso={sale.endsAt} />
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, isRouteErrorResponse, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { config, PLAN } from "../config.server";
import { ensureShop } from "../services/sale-repo.server";
import { isTestBillingShop, setBillingStatus } from "../services/sales.server";
import { logger } from "../lib/logger";
import { ErrorPage } from "../components/error-page";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  await ensureShop(session.shop);

  // Keep the stored plan status in sync; the background worker relies on it.
  try {
    const check = await billing.check({ plans: [PLAN], isTest: await isTestBillingShop(session.shop) });
    await setBillingStatus(session.shop, check.hasActivePayment, check.appSubscriptions[0]?.name ?? null);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.warn("Billing check failed", { shop: session.shop, error: error as Error });
  }

  return { apiKey: config.apiKey };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Sales</s-link>
        <s-link href="/app/sales/new">Create sale</s-link>
        <s-link href="/app/billing">Plan</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses (auth redirects), so that their headers are
// included in the response. Our own 404s and unexpected errors get a friendly page instead of a blank screen.
export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return <ErrorPage title="Sale not found" message="This sale doesn't exist or was deleted." />;
    }
    return boundary.error(error);
  }
  return (
    <ErrorPage
      title="Something went wrong"
      message="We couldn't load this page. Please try again in a moment. Your prices are not affected."
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

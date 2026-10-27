import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const meta: MetaFunction = () => [{ title: "Open PriceTide from Shopify" }];

// Shopify still sends installs through /auth/login?shop=..., which login() turns into the OAuth redirect.
// Without a valid shop there is deliberately no "enter your shop domain" form (App Store requirement 2.3.1):
// merchants open the app from their Shopify admin or install it from the Shopify App Store.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

export default function Auth() {
  const { errors } = useLoaderData<typeof loader>();

  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <s-page>
        <s-section heading="Open PriceTide from Shopify">
          <s-stack gap="base">
            {errors.shop && <s-banner tone="warning">{errors.shop}</s-banner>}
            <s-paragraph>
              PriceTide runs inside your Shopify admin. Open it from Apps in your Shopify admin, or install it from
              the Shopify App Store.
            </s-paragraph>
            <s-link href="/">About PriceTide</s-link>
          </s-stack>
        </s-section>
      </s-page>
    </>
  );
}

import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  // A missing shop is the normal case for a visitor here; the page already explains what to do.
  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "That link doesn't point to a valid Shopify store." };
  }

  return {};
}

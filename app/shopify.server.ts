import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  LogSeverity,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import prisma from "./db.server";
import { config, PLAN } from "./config.server";
import { createTokenCipher } from "./lib/crypto";
import { EncryptedSessionStorage } from "./services/session-storage.server";
import { ensureShop } from "./services/sale-repo.server";
import { refreshDevStoreFlag } from "./services/shop-plan.server";

const shopify = shopifyApp({
  apiKey: config.apiKey,
  apiSecretKey: config.apiSecret,
  apiVersion: ApiVersion.October26,
  scopes: config.scopes,
  appUrl: config.appUrl,
  authPathPrefix: "/auth",
  sessionStorage: new EncryptedSessionStorage(prisma, createTokenCipher(config.keyring)),
  distribution: AppDistribution.AppStore,
  logger: { level: config.isProduction ? LogSeverity.Warning : LogSeverity.Info },
  billing: {
    [PLAN]: {
      trialDays: config.billing.trialDays,
      lineItems: [
        {
          amount: config.billing.amount,
          currencyCode: config.billing.currencyCode,
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      await ensureShop(session.shop);
      await refreshDevStoreFlag(admin, session.shop);
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] } : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

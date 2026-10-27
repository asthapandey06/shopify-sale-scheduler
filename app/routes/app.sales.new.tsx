import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { PLAN } from "../config.server";
import { computeSalePrice, type DiscountType, type Rounding } from "../lib/pricing";
import { LIMITS, parseSaleInput, readJsonBody, type TargetType } from "../lib/validation";
import { createSale, enforceRateLimit, isTestBillingShop } from "../services/sales.server";
import { toErrorResponse, type ActionFailure } from "../services/http.server";
import { kickScheduler } from "../services/scheduler.server";
import { ROUNDING_LABEL, formatMoney, subscribeNever } from "../components/ui";

async function requirePlan(request: Request) {
  const context = await authenticate.admin(request);
  const isTest = await isTestBillingShop(context.session.shop);
  await context.billing.require({
    plans: [PLAN],
    isTest,
    onFailure: async () => context.redirect("/app/billing"),
  });
  return context;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await requirePlan(request);
  const response = await admin.graphql(
    `#graphql
    query SaleSchedulerNewSaleShop { shop { currencyCode } }`,
  );
  const json = (await response.json()) as unknown as { data?: { shop?: { currencyCode?: string } } };
  return { currencyCode: json.data?.shop?.currencyCode ?? "USD" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { session, redirect } = await requirePlan(request);
    enforceRateLimit(session.shop);

    const parsed = parseSaleInput(await readJsonBody(request), new Date());
    if (!parsed.ok) {
      return data<ActionFailure>({ ok: false, message: "Please fix the highlighted fields.", errors: parsed.errors }, { status: 422 });
    }

    const id = await createSale(session.shop, parsed.value);
    if (parsed.value.startsAt.getTime() <= Date.now() + 60_000) kickScheduler();
    return redirect(`/app/sales/${id}`);
  } catch (error) {
    return toErrorResponse(error, { route: "sales.new" });
  }
};

type Picked = {
  id: string;
  title: string;
};

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type DefaultTimes = { startsAt: string; endsAt: string };

const NO_DEFAULT_TIMES: DefaultTimes = { startsAt: "", endsAt: "" };
let cachedDefaultTimes: DefaultTimes = NO_DEFAULT_TIMES;

/** Next full hour to two days later, in the browser's time zone. Same object until the hour changes. */
function getDefaultTimes(): DefaultTimes {
  const start = new Date();
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  const startsAt = toLocalInput(start);
  if (cachedDefaultTimes.startsAt !== startsAt) {
    cachedDefaultTimes = { startsAt, endsAt: toLocalInput(new Date(start.getTime() + 2 * 86_400_000)) };
  }
  return cachedDefaultTimes;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const inputStyle = {
  font: "inherit",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--s-color-border, #c9cccf)",
  width: "100%",
  boxSizing: "border-box" as const,
};

export default function NewSale() {
  const { currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors: Record<string, string> = (actionData && "errors" in actionData && actionData.errors) || {};
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const submitting = navigation.state === "submitting";

  const [name, setName] = useState("");
  const [discountType, setDiscountType] = useState<DiscountType>("PERCENTAGE");
  const [discountValue, setDiscountValue] = useState("20");
  const [rounding, setRounding] = useState<Rounding>("NONE");
  const [targetType, setTargetType] = useState<TargetType>("PRODUCTS");
  const [targets, setTargets] = useState<Picked[]>([]);
  const [startNow, setStartNow] = useState(false);
  // Defaults depend on the browser's clock and time zone, so they are empty on the server
  // and filled in after hydration. null means the merchant hasn't edited the field yet.
  const defaults = useSyncExternalStore(subscribeNever, getDefaultTimes, () => NO_DEFAULT_TIMES);
  const [startsAtInput, setStartsAt] = useState<string | null>(null);
  const [endsAtInput, setEndsAt] = useState<string | null>(null);
  const startsAt = startsAtInput ?? defaults.startsAt;
  const endsAt = endsAtInput ?? defaults.endsAt;

  const example = useMemo(() => {
    const result = computeSalePrice({
      price: "100.00",
      compareAtPrice: null,
      discountType,
      discountValue: discountValue.trim(),
      rounding,
      currencyCode,
    });
    return result.ok ? `${formatMoney("100.00", currencyCode)} → ${formatMoney(result.salePrice, currencyCode)}` : null;
  }, [discountType, discountValue, rounding, currencyCode]);

  const pick = async () => {
    const selected = await shopify.resourcePicker({
      type: targetType === "PRODUCTS" ? "product" : "collection",
      multiple: targetType === "PRODUCTS" ? LIMITS.maxProducts : LIMITS.maxCollections,
      selectionIds: targets.map((t) => ({ id: t.id })),
      ...(targetType === "PRODUCTS" ? { filter: { variants: false } } : {}),
    });
    if (selected) {
      setTargets(selected.map((r) => ({ id: r.id, title: (r as { title?: string }).title ?? r.id })));
    }
  };

  const onSubmit = () => {
    submit(
      {
        name,
        discountType,
        discountValue: discountValue.trim(),
        rounding,
        targetType,
        targets,
        startsAt: startNow ? new Date().toISOString() : localInputToIso(startsAt),
        endsAt: localInputToIso(endsAt),
      },
      { method: "post", encType: "application/json" },
    );
  };

  useEffect(() => {
    if (actionData && !actionData.ok) shopify.toast.show(actionData.message, { isError: true });
  }, [actionData, shopify]);

  return (
    <s-page heading="Create sale">
      <s-button slot="primary-action" variant="primary" onClick={onSubmit} loading={submitting || undefined}>
        Schedule sale
      </s-button>

      <s-section heading="Details">
        <s-stack gap="base">
          <s-text-field
            label="Sale name"
            details="Only you see this, e.g. “Black Friday 2026”."
            value={name}
            maxLength={100}
            error={errors.name}
            onChange={(e) => setName(e.currentTarget.value)}
          ></s-text-field>

          <s-select
            label="Discount type"
            value={discountType}
            error={errors.discountType}
            onChange={(e) => setDiscountType(e.currentTarget.value as DiscountType)}
          >
            <s-option value="PERCENTAGE">Percentage off</s-option>
            <s-option value="FIXED_AMOUNT">Fixed amount off</s-option>
          </s-select>

          <s-text-field
            label={discountType === "PERCENTAGE" ? "Percent off" : `Amount off (${currencyCode})`}
            value={discountValue}
            error={errors.discountValue}
            details={discountType === "PERCENTAGE" ? `Up to ${LIMITS.maxPercent}%.` : "Taken off each variant's price."}
            onChange={(e) => setDiscountValue(e.currentTarget.value)}
          ></s-text-field>

          <s-select
            label="Price rounding"
            value={rounding}
            error={errors.rounding}
            onChange={(e) => setRounding(e.currentTarget.value as Rounding)}
          >
            {Object.entries(ROUNDING_LABEL).map(([value, label]) => (
              <s-option key={value} value={value}>
                {label}
              </s-option>
            ))}
          </s-select>

          {example && <s-text color="subdued">Example: {example}</s-text>}
        </s-stack>
      </s-section>

      <s-section heading="Applies to">
        <s-stack gap="base">
          <s-select
            label="Choose"
            value={targetType}
            onChange={(e) => {
              setTargetType(e.currentTarget.value as TargetType);
              setTargets([]);
            }}
          >
            <s-option value="PRODUCTS">Specific products</s-option>
            <s-option value="COLLECTIONS">Collections</s-option>
          </s-select>

          <s-button onClick={pick}>
            {targets.length > 0 ? "Change selection" : targetType === "PRODUCTS" ? "Select products" : "Select collections"}
          </s-button>

          {errors.targets && <s-text tone="critical">{errors.targets}</s-text>}

          {targets.length > 0 && (
            <s-unordered-list>
              {targets.slice(0, 10).map((t) => (
                <s-list-item key={t.id}>{t.title}</s-list-item>
              ))}
              {targets.length > 10 && <s-list-item>…and {targets.length - 10} more</s-list-item>}
            </s-unordered-list>
          )}
          <s-text color="subdued">
            Every variant gets the discount. Variants already in another running sale are skipped.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="Schedule">
        <s-stack gap="base">
          <s-checkbox
            label="Start immediately"
            checked={startNow || undefined}
            onChange={(e) => setStartNow(e.currentTarget.checked)}
          ></s-checkbox>

          {!startNow && (
            <label>
              <s-text>Starts</s-text>
              <input
                type="datetime-local"
                style={inputStyle}
                value={startsAt}
                onChange={(e) => setStartsAt(e.currentTarget.value)}
                aria-invalid={Boolean(errors.startsAt)}
              />
              {errors.startsAt && <s-text tone="critical">{errors.startsAt}</s-text>}
            </label>
          )}

          <label>
            <s-text>Ends</s-text>
            <input
              type="datetime-local"
              style={inputStyle}
              value={endsAt}
              onChange={(e) => setEndsAt(e.currentTarget.value)}
              aria-invalid={Boolean(errors.endsAt)}
            />
            {errors.endsAt && <s-text tone="critical">{errors.endsAt}</s-text>}
          </label>

          <s-text color="subdued">Times are in your computer&apos;s time zone.</s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

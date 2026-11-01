import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { data, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { SaveBar, useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { computeSalePrice, fixedDiscountExceedsPrice, type DiscountType, type Rounding } from "../lib/pricing";
import { addLocalDays, defaultEndFor, toLocalInput } from "../lib/local-datetime";
import { parseDecimal } from "../lib/money";
import { LIMITS, discountValueError, parseSaleInput, readJsonBody, type TargetType } from "../lib/validation";
import { createSale, enforceRateLimit } from "../services/sales.server";
import { checkPlan } from "../services/plan-check.server";
import { toErrorResponse, type ActionFailure } from "../services/http.server";
import { kickScheduler } from "../services/scheduler.server";
import { ROUNDING_LABEL, formatMoney, subscribeNever } from "../components/ui";

async function requirePlan(request: Request, options: { fresh?: boolean } = {}) {
  const context = await authenticate.admin(request);
  if (!(await checkPlan(context.billing, context.session.shop, options)).hasActivePayment) throw context.redirect("/app/billing");
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
    const { session, redirect } = await requirePlan(request, { fresh: true });
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
  /** Lowest variant price from the picker (products only); used for the "discount too large" warning. */
  minPrice?: string;
  /** Product count of a collection, when the picker reports it. */
  productsCount?: number;
};

function collectionProductCount(resource: unknown): number | undefined {
  const raw = (resource as { productsCount?: number | { count?: number } }).productsCount;
  const count = typeof raw === "number" ? raw : raw?.count;
  return typeof count === "number" ? count : undefined;
}

function lowestVariantPrice(resource: unknown): string | undefined {
  const variants = (resource as { variants?: { price?: string }[] }).variants;
  const prices = (variants ?? []).map((v) => v.price).filter((p): p is string => typeof p === "string");
  const parsed = prices.flatMap((p) => {
    const n = parseDecimal(p);
    return n === null ? [] : [{ p, n }];
  });
  return parsed.length > 0 ? parsed.reduce((a, b) => (b.n < a.n ? b : a)).p : undefined;
}

const DEFAULT_DAYS = 2;

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
    cachedDefaultTimes = { startsAt, endsAt: toLocalInput(addLocalDays(start, DEFAULT_DAYS)) };
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
const inputErrorStyle = { ...inputStyle, border: "1px solid var(--s-color-border-critical, #e51c00)" };

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
  // Until the merchant sets an end, it follows the start (same time of day, two days later).
  const endsAt = endsAtInput ?? (startsAtInput !== null ? (defaultEndFor(startsAtInput, DEFAULT_DAYS) ?? defaults.endsAt) : defaults.endsAt);

  // Server errors disappear once the merchant touches the field again, until the next failed submit.
  const [edited, setEdited] = useState<Record<string, unknown>>({});
  const touch = (field: string) => setEdited((current) => ({ ...current, [field]: actionData ?? null }));
  const errorFor = (field: string): string | undefined => (actionData && edited[field] === actionData ? undefined : errors[field]);

  // The default start is "the next full hour": keep it current while the form stays open and is untouched.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startsAtInput !== null || startNow) return;
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [startsAtInput, startNow]);

  const trimmedValue = discountValue.trim();
  const valueError = trimmedValue === "" ? null : discountValueError(discountType, trimmedValue);

  const example = useMemo(() => {
    if (trimmedValue === "" || discountValueError(discountType, trimmedValue)) return null;
    const result = computeSalePrice({
      price: "100.00",
      compareAtPrice: null,
      discountType,
      discountValue: trimmedValue,
      rounding,
      currencyCode,
    });
    return result.ok ? `${formatMoney("100.00", currencyCode)} → ${formatMoney(result.salePrice, currencyCode)}` : null;
  }, [discountType, trimmedValue, rounding, currencyCode]);

  // Variants priced at or below a fixed discount are skipped at start; tell the merchant now.
  const tooCheap = useMemo(
    () => targets.filter((t) => t.minPrice !== undefined && fixedDiscountExceedsPrice(discountType, discountValue, t.minPrice)),
    [targets, discountType, discountValue],
  );

  const pick = async () => {
    const selected = await shopify.resourcePicker({
      type: targetType === "PRODUCTS" ? "product" : "collection",
      multiple: targetType === "PRODUCTS" ? LIMITS.maxProducts : LIMITS.maxCollections,
      selectionIds: targets.map((t) => ({ id: t.id })),
      ...(targetType === "PRODUCTS" ? { filter: { variants: false } } : {}),
    });
    if (selected) {
      touch("targets");
      setTargets(
        selected.map((r) => ({
          id: r.id,
          title: (r as { title?: string }).title ?? r.id,
          ...(targetType === "PRODUCTS" ? { minPrice: lowestVariantPrice(r) } : { productsCount: collectionProductCount(r) }),
        })),
      );
    }
  };

  const dirty =
    name.trim() !== "" ||
    targets.length > 0 ||
    discountType !== "PERCENTAGE" ||
    targetType !== "PRODUCTS" ||
    discountValue !== "20" ||
    rounding !== "NONE" ||
    startNow ||
    startsAtInput !== null ||
    endsAtInput !== null;

  const discard = () => {
    setName("");
    setDiscountType("PERCENTAGE");
    setDiscountValue("20");
    setRounding("NONE");
    setTargetType("PRODUCTS");
    setTargets([]);
    setStartNow(false);
    setStartsAt(null);
    setEndsAt(null);
    setEdited({});
  };

  const onSubmit = () => {
    // The save bar button calls this too: ignore double clicks and values the form already flags.
    if (submitting || valueError) return;
    submit(
      {
        name,
        discountType,
        discountValue: discountValue.trim(),
        rounding,
        targetType,
        targets: targets.map(({ id, title }) => ({ id, title })),
        startsAt: startNow ? new Date().toISOString() : localInputToIso(startsAt),
        endsAt: localInputToIso(endsAt),
      },
      { method: "post", encType: "application/json" },
    );
  };

  useEffect(() => {
    if (!actionData || actionData.ok) return;
    shopify.toast.show(actionData.message, { isError: true });
    // The toast is easy to miss when the broken field is off screen: bring the first one into view.
    if ("errors" in actionData) {
      requestAnimationFrame(() =>
        document.querySelector('[data-has-error="true"]')?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Create sale">
      <s-button slot="primary-action" variant="primary" onClick={onSubmit} loading={submitting || undefined}>
        Schedule sale
      </s-button>

      {/* Contextual save bar: signals unsaved input and asks before the merchant navigates away. */}
      <SaveBar id="new-sale-save-bar" open={dirty && !submitting} discardConfirmation>
        <button {...{ variant: "primary" }} onClick={onSubmit}>
          Schedule sale
        </button>
        <button onClick={discard}>Discard</button>
      </SaveBar>

      <s-section heading="Details">
        <s-stack gap="base">
          <s-text-field
            label="Sale name"
            details="Only you see this, e.g. “Black Friday 2026”."
            value={name}
            maxLength={100}
            error={errorFor("name")}
            data-has-error={errorFor("name") ? "true" : undefined}
            onChange={(e) => {
              touch("name");
              setName(e.currentTarget.value);
            }}
          ></s-text-field>

          <s-select
            label="Discount type"
            value={discountType}
            error={errorFor("discountType")}
            data-has-error={errorFor("discountType") ? "true" : undefined}
            onChange={(e) => {
              touch("discountType");
              setDiscountType(e.currentTarget.value as DiscountType);
            }}
          >
            <s-option value="PERCENTAGE">Percentage off</s-option>
            <s-option value="FIXED_AMOUNT">Fixed amount off</s-option>
          </s-select>

          <s-text-field
            label={discountType === "PERCENTAGE" ? "Percent off" : `Amount off (${currencyCode})`}
            value={discountValue}
            error={valueError ?? errorFor("discountValue")}
            data-has-error={valueError ?? errorFor("discountValue") ? "true" : undefined}
            details={discountType === "PERCENTAGE" ? `Up to ${LIMITS.maxPercent}%.` : "Taken off each variant's price."}
            onChange={(e) => {
              touch("discountValue");
              setDiscountValue(e.currentTarget.value);
            }}
          ></s-text-field>

          <s-select
            label="Price rounding"
            value={rounding}
            error={errorFor("rounding")}
            data-has-error={errorFor("rounding") ? "true" : undefined}
            onChange={(e) => {
              touch("rounding");
              setRounding(e.currentTarget.value as Rounding);
            }}
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

          {errorFor("targets") && (
            <s-text tone="critical" data-has-error="true">
              {errorFor("targets")}
            </s-text>
          )}

          {targets.length > 0 && (
            <s-unordered-list>
              {targets.slice(0, 10).map((t) => (
                <s-list-item key={t.id}>
                  {t.title}
                  {t.productsCount !== undefined ? ` (${t.productsCount} ${t.productsCount === 1 ? "product" : "products"})` : ""}
                </s-list-item>
              ))}
              {targets.length > 10 && <s-list-item>…and {targets.length - 10} more</s-list-item>}
            </s-unordered-list>
          )}
          {tooCheap.length > 0 && (
            <s-banner tone="warning" heading="Discount is larger than some prices">
              <s-paragraph>
                {discountValue.trim()} {currencyCode} off is at least the price of{" "}
                {tooCheap
                  .slice(0, 3)
                  .map((t) => t.title)
                  .join(", ")}
                {tooCheap.length > 3 ? ` and ${tooCheap.length - 3} more` : ""}. Those variants will be skipped, and
                their prices won&apos;t change.
              </s-paragraph>
            </s-banner>
          )}
          <s-text color="subdued">
            Every variant gets the discount. Variants already in another running sale are skipped
            {targetType === "COLLECTIONS" ? ", and draft or archived products in a collection are left out." : "."}
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
                style={errorFor("startsAt") ? inputErrorStyle : inputStyle}
                value={startsAt}
                onChange={(e) => {
                  touch("startsAt");
                  touch("endsAt");
                  setStartsAt(e.currentTarget.value);
                }}
                aria-invalid={Boolean(errorFor("startsAt"))}
              />
              {errorFor("startsAt") && (
                <s-text tone="critical" data-has-error="true">
                  {errorFor("startsAt")}
                </s-text>
              )}
            </label>
          )}

          <label>
            <s-text>Ends</s-text>
            <input
              type="datetime-local"
              style={errorFor("endsAt") ? inputErrorStyle : inputStyle}
              value={endsAt}
              onChange={(e) => {
                touch("endsAt");
                setEndsAt(e.currentTarget.value);
              }}
              aria-invalid={Boolean(errorFor("endsAt"))}
            />
            {errorFor("endsAt") && (
              <s-text tone="critical" data-has-error="true">
                {errorFor("endsAt")}
              </s-text>
            )}
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

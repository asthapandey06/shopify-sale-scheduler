import { DISCOUNT_TYPES, ROUNDING_MODES, type DiscountType, type Rounding } from "./pricing.ts";

/**
 * Strict allow-list validation for everything the browser sends us.
 * Unknown fields are ignored, every field has a type, length and range limit.
 */

export const TARGET_TYPES = ["PRODUCTS", "COLLECTIONS"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export interface SaleTarget {
  id: string;
  title: string;
}

export interface SaleInput {
  name: string;
  discountType: DiscountType;
  discountValue: string;
  rounding: Rounding;
  targetType: TargetType;
  targets: SaleTarget[];
  startsAt: Date;
  endsAt: Date;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

export const LIMITS = {
  nameMax: 100,
  titleMax: 255,
  maxProducts: 250,
  maxCollections: 5,
  maxPercent: 90,
  maxFixedAmount: 1_000_000,
  maxDurationDays: 90,
  maxScheduleAheadDays: 365,
  /** Allow a "start now" submitted a little in the past (slow form, clock skew). */
  startGraceMs: 10 * 60 * 1000,
  minDurationMs: 5 * 60 * 1000,
} as const;

const GID_RE = {
  PRODUCTS: /^gid:\/\/shopify\/Product\/\d{1,20}$/,
  COLLECTIONS: /^gid:\/\/shopify\/Collection\/\d{1,20}$/,
} as const;

// Control characters (except tab) and bidi overrides are stripped from text.
function isUnsafeChar(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09) ||
    code === 0x7f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (!isUnsafeChar(value.charCodeAt(i))) out += value[i];
  }
  return out.trim().slice(0, max);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 40) return null;
  // Require an explicit timezone so the server never guesses the merchant's zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseSaleInput(raw: unknown, now: Date): ValidationResult<SaleInput> {
  const errors: Record<string, string> = {};
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const name = cleanText(body.name, LIMITS.nameMax);
  if (!name) errors.name = "Give the sale a name";

  const discountType = body.discountType;
  if (!isOneOf(DISCOUNT_TYPES, discountType)) errors.discountType = "Choose a discount type";

  const rounding = body.rounding ?? "NONE";
  if (!isOneOf(ROUNDING_MODES, rounding)) errors.rounding = "Choose a rounding option";

  const rawValue = typeof body.discountValue === "string" ? body.discountValue.trim() : String(body.discountValue ?? "");
  let discountValue = "";
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(rawValue)) {
    errors.discountValue = "Enter a number with up to 2 decimals";
  } else {
    const n = Number(rawValue);
    if (discountType === "PERCENTAGE" && (n <= 0 || n > LIMITS.maxPercent)) {
      errors.discountValue = `Percentage must be between 0 and ${LIMITS.maxPercent}`;
    } else if (discountType === "FIXED_AMOUNT" && (n <= 0 || n > LIMITS.maxFixedAmount)) {
      errors.discountValue = "Amount must be greater than 0";
    } else {
      discountValue = rawValue;
    }
  }

  const targetType = body.targetType;
  const targets: SaleTarget[] = [];
  if (!isOneOf(TARGET_TYPES, targetType)) {
    errors.targets = "Choose products or collections";
  } else {
    const list = Array.isArray(body.targets) ? body.targets : [];
    const max = targetType === "PRODUCTS" ? LIMITS.maxProducts : LIMITS.maxCollections;
    const seen = new Set<string>();
    for (const item of list.slice(0, max + 1)) {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id : "";
      if (!GID_RE[targetType].test(id)) {
        errors.targets = "One of the selected items is invalid";
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      targets.push({ id, title: cleanText(entry.title, LIMITS.titleMax) || id });
    }
    if (!errors.targets) {
      if (targets.length === 0) errors.targets = "Select at least one item";
      else if (list.length > max) errors.targets = `Select at most ${max} ${targetType === "PRODUCTS" ? "products" : "collections"}`;
    }
  }

  const startsAt = parseDate(body.startsAt);
  const endsAt = parseDate(body.endsAt);
  if (!startsAt) errors.startsAt = "Enter a valid start date and time";
  if (!endsAt) errors.endsAt = "Enter a valid end date and time";
  if (startsAt && endsAt) {
    const nowMs = now.getTime();
    if (startsAt.getTime() < nowMs - LIMITS.startGraceMs) errors.startsAt = "Start time is in the past";
    else if (startsAt.getTime() > nowMs + LIMITS.maxScheduleAheadDays * 86_400_000) errors.startsAt = "Start must be within a year";
    const duration = endsAt.getTime() - startsAt.getTime();
    if (duration < LIMITS.minDurationMs) errors.endsAt = "Sale must run for at least 5 minutes";
    else if (duration > LIMITS.maxDurationDays * 86_400_000) errors.endsAt = `Sale can run for at most ${LIMITS.maxDurationDays} days`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      discountType: discountType as DiscountType,
      discountValue,
      rounding: rounding as Rounding,
      targetType: targetType as TargetType,
      targets,
      // A start time slightly in the past means "start now".
      startsAt: startsAt!.getTime() < now.getTime() ? now : startsAt!,
      endsAt: endsAt!,
    },
  };
}

/** Reads a JSON body with a hard size cap. */
export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new BodyTooLargeError();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new BodyTooLargeError();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidBodyError();
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

export class InvalidBodyError extends Error {
  constructor() {
    super("Request body is not valid JSON");
    this.name = "InvalidBodyError";
  }
}

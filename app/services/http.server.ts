import { data } from "react-router";
import { logger } from "../lib/logger";
import { BodyTooLargeError, InvalidBodyError } from "../lib/validation";
import { HttpError } from "./sales.server";

export interface ActionFailure {
  ok: false;
  message: string;
  errors?: Record<string, string>;
}

/**
 * Converts an error thrown in a loader/action into a safe client response.
 * - Responses (auth redirects from the Shopify library) are re-thrown untouched.
 * - Known errors get their public message; everything else gets a generic
 *   message while the details go to the server log only.
 */
export function toErrorResponse(error: unknown, context: Record<string, unknown> = {}) {
  if (error instanceof Response) throw error;
  if (error instanceof HttpError) {
    return data<ActionFailure>({ ok: false, message: error.publicMessage }, { status: error.status, headers: error.headers });
  }
  if (error instanceof BodyTooLargeError) {
    return data<ActionFailure>({ ok: false, message: "Request is too large." }, { status: 413 });
  }
  if (error instanceof InvalidBodyError) {
    return data<ActionFailure>({ ok: false, message: "Request could not be read." }, { status: 400 });
  }
  logger.error("Unhandled error in request", { ...context, error: error as Error });
  return data<ActionFailure>({ ok: false, message: "Something went wrong. Please try again." }, { status: 500 });
}

/** Ensures route params look like our ids before they reach the database. */
export function assertId(value: string | undefined): string {
  if (!value || !/^[a-z0-9]{10,40}$/i.test(value)) {
    throw new Response("Not found", { status: 404 });
  }
  return value;
}

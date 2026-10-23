/**
 * Security headers added to every document and data response.
 *
 * X-Frame-Options is deliberately NOT set: the app must render inside the
 * Shopify admin iframe. Framing is restricted instead by the
 * Content-Security-Policy frame-ancestors header that the Shopify library adds
 * per shop (addDocumentResponseHeaders).
 */
export function applySecurityHeaders(headers: Headers, isProduction: boolean): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (isProduction) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

/**
 * Security headers added to every document and data response.
 *
 * X-Frame-Options is deliberately NOT set: the app must render inside the
 * Shopify admin iframe. Framing is restricted instead by the
 * Content-Security-Policy frame-ancestors header that the Shopify library adds
 * per shop (addDocumentResponseHeaders). Public pages, which never run inside
 * the admin, may not be framed at all. Embedded paths are left to the library
 * so the admin iframe is never blocked.
 */
const PUBLIC_PAGES = new Set(["/", "/privacy", "/auth/login"]);

export function applySecurityHeaders(headers: Headers, isProduction: boolean, pathname?: string): void {
  if (pathname && PUBLIC_PAGES.has(pathname) && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (isProduction) {
    headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

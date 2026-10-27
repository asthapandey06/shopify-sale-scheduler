---
description: Smoke-tests PriceTide's web pages in a real browser with the Playwright MCP — public pages (/, /privacy, /healthz) and, when the owner is logged in, the embedded app in the Shopify dev store. Use when the user asks to test the UI, check pages load, take screenshots, or verify a UI change in the browser.
---

# UI smoke test (Playwright MCP)

Requires the `playwright` MCP server from `.mcp.json` (approve it when Claude Code asks).
The browser runs headless inside Cloud Shell.

## 1. Get the app URL

- During `npm run dev`, the Shopify CLI prints the tunnel/app URL. Ask the owner for it if it isn't
  in the conversation. Never guess URLs.

## 2. Public pages (no login needed)

For each of `/`, `/privacy`, `/healthz`:
1. Navigate with the Playwright MCP.
2. Check: page loads (no error page), no console errors, expected content:
   - `/` — app name and description, **no shop-domain form**, link to privacy policy
   - `/privacy` — policy text, contact email filled in (not empty)
   - `/healthz` — JSON `{"ok":true}`
3. Take a screenshot of `/` and `/privacy` and report them.
4. Check layout at a phone width (resize to ~390px wide) for `/` and `/privacy`.

## 3. Embedded app (only if the owner asks and is logged in)

The admin pages only render inside the Shopify admin iframe and need the owner's Shopify login.
- Do **not** ask for or type the owner's password, 2FA codes or any credentials.
- If the session isn't logged in, stop and tell the owner to test those pages manually using
  the live test plan in `APP_STORE_SUBMISSION.md`.

## Rules

- Read-only: don't create, cancel or end sales, or change billing, unless the owner explicitly asks
  and confirms it's a development store.
- Report findings as: page | result | issue (with screenshot when something is wrong).

## Troubleshooting

- "Executable doesn't exist" → install the browser once: `npx -y playwright install chromium`
- Missing shared libraries on launch → `sudo npx -y playwright install-deps chromium`
  (Cloud Shell resets system packages, so this may be needed again after a restart).

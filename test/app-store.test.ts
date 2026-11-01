import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = new URL("../app/routes/", import.meta.url).pathname;

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Regression (QA PT-01): two buttons in an s-banner's `secondary-actions` slot rendered only one, which hid
// the confirm button on the sale page. A banner with several buttons puts them in its body instead.
test("no s-banner puts more than one button in its secondary-actions slot", () => {
  const offenders = routeFiles(ROUTES_DIR).filter((file) => {
    const source = readFileSync(file, "utf8");
    const banners = source.match(/<s-banner\b[\s\S]*?<\/s-banner>/g) ?? [];
    return banners.some((banner) => (banner.match(/slot="secondary-actions"/g) ?? []).length > 1);
  });
  assert.deepEqual(offenders, []);
});

// App Store requirement 2.3.1: installs start from Shopify, so no page may ask for a shop domain.
test("no route renders a shop-domain input", () => {
  const offenders = routeFiles(ROUTES_DIR).filter((file) => {
    const source = readFileSync(file, "utf8");
    return /name=["']shop["']/.test(source) || /label=["']Shop domain["']/i.test(source);
  });
  assert.deepEqual(offenders, []);
});

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

// App Store requirement 2.3.1: installs start from Shopify, so no page may ask for a shop domain.
test("no route renders a shop-domain input", () => {
  const offenders = routeFiles(ROUTES_DIR).filter((file) => {
    const source = readFileSync(file, "utf8");
    return /name=["']shop["']/.test(source) || /label=["']Shop domain["']/i.test(source);
  });
  assert.deepEqual(offenders, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createTokenCipher,
  decryptTokenFields,
  encryptTokenFields,
  parseKeyring,
  safeEqual,
} from "../app/lib/crypto.ts";
import { parseSaleInput, readJsonBody, BodyTooLargeError, InvalidBodyError, cleanText } from "../app/lib/validation.ts";
import { createRateLimiter } from "../app/lib/rate-limit.ts";
import { createLogger, redact } from "../app/lib/logger.ts";
import { loadConfig } from "../app/lib/env.ts";

const key = () => randomBytes(32).toString("base64");

test("tokens round-trip and are bound to their row", () => {
  const cipher = createTokenCipher(parseKeyring(`k1:${key()}`));
  const enc = cipher.encrypt("shpat_secret", "offline_demo.myshopify.com:access");
  assert.ok(enc.startsWith("enc:v1:k1:"));
  assert.ok(!enc.includes("shpat_secret"));
  assert.notEqual(enc, cipher.encrypt("shpat_secret", "offline_demo.myshopify.com:access"), "random IV");
  assert.equal(cipher.decrypt(enc, "offline_demo.myshopify.com:access"), "shpat_secret");
  assert.throws(() => cipher.decrypt(enc, "offline_other.myshopify.com:access"));
});

test("tampered ciphertext is rejected", () => {
  const cipher = createTokenCipher(parseKeyring(`k1:${key()}`));
  const enc = cipher.encrypt("shpat_secret", "aad");
  const parts = enc.split(":");
  const data = Buffer.from(parts[5], "base64url");
  data[0] ^= 1;
  parts[5] = data.toString("base64url");
  assert.throws(() => cipher.decrypt(parts.join(":"), "aad"));
});

test("key rotation: old values still decrypt, new values use the new key", () => {
  const k1 = key();
  const old = createTokenCipher(parseKeyring(`k1:${k1}`));
  const value = old.encrypt("token", "aad");
  const rotated = createTokenCipher(parseKeyring(`k2:${key()},k1:${k1}`));
  assert.equal(rotated.decrypt(value, "aad"), "token");
  assert.ok(rotated.needsRotation(value));
  assert.ok(rotated.encrypt("token", "aad").startsWith("enc:v1:k2:"));
  assert.throws(() => createTokenCipher(parseKeyring(`k3:${key()}`)).decrypt(value, "aad"), /Unknown encryption key/);
});

test("legacy plaintext tokens are readable for migration", () => {
  const cipher = createTokenCipher(parseKeyring(`k1:${key()}`));
  assert.equal(cipher.decrypt("shpat_plain", "aad"), "shpat_plain");
});

test("session token fields are encrypted and restored", () => {
  const cipher = createTokenCipher(parseKeyring(`k1:${key()}`));
  const session = { id: "offline_a.myshopify.com", shop: "a.myshopify.com", accessToken: "at", refreshToken: "rt" };
  const stored = encryptTokenFields(session, cipher);
  assert.notEqual(stored.accessToken, "at");
  assert.notEqual(stored.refreshToken, "rt");
  assert.equal(stored.shop, "a.myshopify.com");
  assert.deepEqual(decryptTokenFields(stored, cipher), session);
  // Access and refresh ciphertexts can't be swapped.
  assert.throws(() => decryptTokenFields({ ...stored, accessToken: stored.refreshToken }, cipher));
});

test("keyring validation", () => {
  assert.throws(() => parseKeyring(undefined), /not set/);
  assert.throws(() => parseKeyring("k1:short"), /32 bytes/);
  assert.throws(() => parseKeyring(`bad id:${key()}`), /Invalid encryption key id/);
  const k = key();
  assert.throws(() => parseKeyring(`k1:${k},k1:${k}`), /Duplicate/);
});

test("safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
});

const NOW = new Date("2026-11-01T10:00:00Z");
const valid = {
  name: "Black Friday",
  discountType: "PERCENTAGE",
  discountValue: "20",
  rounding: "END_99",
  targetType: "PRODUCTS",
  targets: [{ id: "gid://shopify/Product/123", title: "Shirt" }],
  startsAt: "2026-11-01T16:00:00+05:30",
  endsAt: "2026-11-02T16:00:00+05:30",
};

test("valid sale input is accepted and normalized", () => {
  const r = parseSaleInput(valid, NOW);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.value.startsAt.toISOString(), "2026-11-01T10:30:00.000Z"); // 16:00 IST
    assert.equal(r.value.targets.length, 1);
  }
  // "Start now" submitted a few minutes late is clamped to now.
  const late = parseSaleInput({ ...valid, startsAt: "2026-11-01T09:55:00Z" }, NOW);
  assert.ok(late.ok && late.value.startsAt.getTime() === NOW.getTime());
});

test("malicious and malformed input is rejected", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...valid, name: "" }, "name"],
    [{ ...valid, discountType: "FREE" }, "discountType"],
    [{ ...valid, discountValue: "95" }, "discountValue"],
    [{ ...valid, discountValue: "1e3" }, "discountValue"],
    [{ ...valid, discountValue: "-5" }, "discountValue"],
    [{ ...valid, rounding: "UP" }, "rounding"],
    [{ ...valid, targets: [{ id: "gid://shopify/Customer/1" }] }, "targets"],
    [{ ...valid, targets: [{ id: "gid://shopify/Product/1' OR 1=1" }] }, "targets"],
    [{ ...valid, targets: [] }, "targets"],
    [{ ...valid, targets: Array.from({ length: 251 }, (_, i) => ({ id: `gid://shopify/Product/${i + 1}` })) }, "targets"],
    [{ ...valid, targetType: "COLLECTIONS" }, "targets"],
    [{ ...valid, startsAt: "2026-11-01T16:00" }, "startsAt"], // no timezone
    [{ ...valid, startsAt: "2026-10-01T12:00:00Z" }, "startsAt"], // past
    [{ ...valid, endsAt: valid.startsAt }, "endsAt"],
    [{ ...valid, endsAt: "2027-06-01T00:00:00Z" }, "endsAt"], // > 90 days
  ];
  for (const [input, field] of cases) {
    const r = parseSaleInput(input, NOW);
    assert.equal(r.ok, false, `expected rejection for ${field}: ${JSON.stringify(input).slice(0, 80)}`);
    if (!r.ok) assert.ok(r.errors[field], `expected error on ${field}, got ${JSON.stringify(r.errors)}`);
  }
  assert.equal(parseSaleInput(null, NOW).ok, false);
  assert.equal(parseSaleInput("x", NOW).ok, false);
});

test("text is cleaned of control and bidi characters", () => {
  assert.equal(cleanText("  Sale‮\u0000 2026 ", 100), "Sale 2026");
  assert.equal(cleanText("x".repeat(300), 100).length, 100);
  assert.equal(cleanText(42, 10), "");
});

test("cleanText strips every unsafe range and keeps tabs and non-ASCII text", () => {
  const unsafe = ["\u0000", "\u0008", "\n", "\r", "\u001f", "\u007f", "‪", "‮", "⁦", "⁩"];
  for (const ch of unsafe) assert.equal(cleanText(`a${ch}b`, 10), "ab", `U+${ch.charCodeAt(0).toString(16)}`);
  assert.equal(cleanText("a\tb", 10), "a\tb");
  assert.equal(cleanText("Été 🎉 セール  ", 20), "Été 🎉 セール  ".trim());
});

test("JSON body size limit", async () => {
  const big = new Request("https://x.test", { method: "POST", body: JSON.stringify({ a: "x".repeat(70_000) }) });
  await assert.rejects(readJsonBody(big), BodyTooLargeError);
  const bad = new Request("https://x.test", { method: "POST", body: "{nope" });
  await assert.rejects(readJsonBody(bad), InvalidBodyError);
  const ok = new Request("https://x.test", { method: "POST", body: '{"a":1}' });
  assert.deepEqual(await readJsonBody(ok), { a: 1 });
});

test("rate limiter allows bursts then throttles per key", () => {
  let t = 0;
  const limiter = createRateLimiter({ capacity: 3, refillPerMinute: 6, now: () => t });
  assert.ok(limiter.take("a") && limiter.take("a") && limiter.take("a"));
  assert.ok(!limiter.take("a"));
  assert.ok(limiter.take("b"), "keys are independent");
  assert.equal(limiter.retryAfterSeconds("a"), 10);
  t += 10_000;
  assert.ok(limiter.take("a"));
});

test("logger redacts secrets", () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line) });
  log.info("hello", { shop: "a.myshopify.com", accessToken: "shpat_x", nested: { apiSecret: "s", ok: 1 } });
  assert.ok(!lines[0].includes("shpat_x"));
  assert.ok(!lines[0].includes('"s"'));
  assert.ok(lines[0].includes("a.myshopify.com"));
  assert.deepEqual(redact({ authorization: "Bearer x" }), { authorization: "[redacted]" });
});

test("config fails fast with every problem listed", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", SHOPIFY_APP_URL: "http://insecure.example", SCOPES: "write_products,read_customers" }),
    (error: Error) =>
      /SHOPIFY_API_KEY is required/.test(error.message) &&
      /must use https/.test(error.message) &&
      /read_customers/.test(error.message) &&
      /TOKEN_ENCRYPTION_KEYS/.test(error.message) &&
      /SUPPORT_EMAIL/.test(error.message),
  );
  const config = loadConfig({
    NODE_ENV: "production",
    SHOPIFY_API_KEY: "k",
    SHOPIFY_API_SECRET: "s",
    SHOPIFY_APP_URL: "https://app.example.com",
    DATABASE_URL: "postgres://x",
    TOKEN_ENCRYPTION_KEYS: `k1:${key()}`,
    SUPPORT_EMAIL: "support@example.com",
  });
  assert.equal(config.billing.testMode, false);
  assert.deepEqual(config.scopes, ["write_products"]);
});

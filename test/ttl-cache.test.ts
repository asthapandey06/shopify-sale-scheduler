import assert from "node:assert/strict";
import { test } from "node:test";
import { createTtlCache } from "../app/lib/ttl-cache.ts";

test("concurrent callers share one load and later ones reuse it until the ttl passes", async () => {
  let time = 0;
  let loads = 0;
  const cache = createTtlCache<number>(1000, () => time);
  const load = async () => ++loads;
  const [a, b] = await Promise.all([cache.get("s", load), cache.get("s", load)]);
  assert.deepEqual([a, b, loads], [1, 1, 1]);
  time = 999;
  assert.equal(await cache.get("s", load), 1);
  time = 1001;
  assert.equal(await cache.get("s", load), 2);
});

test("keys are independent and invalidate forces a reload", async () => {
  let loads = 0;
  const cache = createTtlCache<number>(1000, () => 0);
  const load = async () => ++loads;
  await cache.get("a", load);
  await cache.get("b", load);
  assert.equal(loads, 2);
  cache.invalidate("a");
  assert.equal(await cache.get("a", load), 3);
});

test("failures are not cached", async () => {
  let calls = 0;
  const cache = createTtlCache<string>(1000, () => 0);
  await assert.rejects(cache.get("s", async () => { calls++; throw new Error("boom"); }));
  assert.equal(await cache.get("s", async () => { calls++; return "ok"; }), "ok");
  assert.equal(calls, 2);
});

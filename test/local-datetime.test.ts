import { test } from "node:test";
import assert from "node:assert/strict";
import { addLocalDays, defaultEndFor, toLocalInput } from "../app/lib/local-datetime.ts";

function inTimeZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

// Regression (QA PT-05): the default end time must keep the start's wall-clock time.
test("the default end keeps the start's local time across a daylight-saving change", () => {
  // US clocks go back on 1 Nov 2026: two days after 31 Oct 14:00 is still 14:00 locally.
  inTimeZone("America/New_York", () => {
    assert.equal(defaultEndFor("2026-10-31T14:00", 2), "2026-11-02T14:00");
    // The old millisecond arithmetic gave 13:00 here.
    const start = new Date("2026-10-31T14:00");
    assert.equal(toLocalInput(new Date(start.getTime() + 2 * 86_400_000)), "2026-11-02T13:00");
  });
});

test("the default end follows an edited start", () => {
  inTimeZone("Asia/Kolkata", () => {
    assert.equal(defaultEndFor("2026-10-29T14:00", 2), "2026-10-31T14:00");
    assert.equal(toLocalInput(addLocalDays(new Date("2026-10-29T14:00"), 1)), "2026-10-30T14:00");
  });
});

test("an empty or invalid start gives no default end", () => {
  assert.equal(defaultEndFor("", 2), null);
  assert.equal(defaultEndFor("not a date", 2), null);
});

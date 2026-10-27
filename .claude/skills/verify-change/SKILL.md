---
description: Verifies a code change in PriceTide before it is called done — runs typecheck, tests and lint, reads failures, fixes them, and reports. Use after editing code, before committing, or when the user asks "does it build", "run the checks", "is this ready", or "why is CI failing".
---

# Verify a change

Run the project's checks and get them green without changing app behaviour.

## Steps

1. Make sure dependencies and the Prisma client are current:
   - If `node_modules` is missing or `package.json`/`package-lock.json` changed: `npm install`
   - If `prisma/schema.prisma` changed or the client is missing: `npx prisma generate`
2. Run, in this order, stopping to fix each stage before moving on:
   1. `npm run typecheck`
   2. `npm test`
   3. `npm run lint`
3. For each failure:
   - Read the full error and the file it points to before editing.
   - Fix the root cause. Do **not** silence errors with `any`, `@ts-ignore`, `eslint-disable`,
     skipped tests, or by loosening assertions.
   - If a test fails, decide whether the code or the test is wrong. Never weaken a test that
     protects a safety invariant listed in AGENTS.md.
4. Re-run the full sequence until everything passes.
5. Report:
   - What failed and why (one line each)
   - What you changed (files + one-line reason)
   - Final result of `npm run check`

## Notes

- Tests use Node's built-in runner and must not need network or a database.
- `app/lib/*` imports use `.ts` extensions so tests run directly under Node; keep that convention.
- If a fix needs a new dependency, a schema change, or touches billing/scopes, stop and ask first.

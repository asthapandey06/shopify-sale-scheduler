---
description: Commits and pushes the current work for PriceTide safely — runs checks, reviews the diff for secrets and unintended changes, writes a clear message, syncs with GitHub, and pushes. Use when the user says "commit", "push", "save my work to GitHub", or "ship it".
disable-model-invocation: true
---

# Commit and push

## Steps

1. `git status` and `git diff` — read what changed.
2. Stop and warn if the diff contains any of:
   - `.env` or other env files, keys (`sk-`, `shpat_`, `shpss_`, `k1:`), passwords, tokens
   - `node_modules/`, `build/`, `graphify-out/`, `.shopify/`
   - unrelated changes the user didn't ask for
3. Run the `verify-change` skill. Don't commit with failing checks unless the user explicitly says to.
4. Stage only the intended files (`git add <paths>`, avoid blind `git add .` when unrelated files changed).
5. Commit with a short imperative message, e.g. `Add rounding option to fixed-amount sales`.
6. Sync and push:
   ```bash
   git fetch origin
   git log --oneline HEAD..origin/main     # show incoming commits first
   git pull --rebase origin main
   git push
   ```
   - If incoming commits are Dependabot major upgrades the user didn't intend, stop and ask.
   - On rebase conflicts, show the conflicting files and resolve with the user; `git rebase --abort` backs out.
7. Report the commit hash, message, and push result.

## Never

- Force-push to `main`, rewrite published history, or skip hooks (`--no-verify`) unless the user asks.

# Security operations

## Reporting

Report vulnerabilities privately to the app owner's support email. Do not open public issues.

## Secrets

| Secret | Where | Notes |
| --- | --- | --- |
| `SHOPIFY_API_SECRET` | Host env only | Verifies webhooks and OAuth. Rotate in the Partner Dashboard if exposed. |
| `TOKEN_ENCRYPTION_KEYS` | Host env only | Encrypts Shopify tokens in the database. Back it up separately from DB backups. |
| `DATABASE_URL` | Host env only | Use TLS (`sslmode=require`) with managed databases. |
| `CRON_SECRET` | Host env + cron service | Only needed when using `/jobs/tick`. |

Never commit `.env`. Never log request bodies or sessions (the logger redacts token-like keys anyway).

## Rotating the token encryption key

1. Generate a key: `node -e "console.log('k2:' + require('crypto').randomBytes(32).toString('base64'))"`
2. Deploy with `TOKEN_ENCRYPTION_KEYS=k2:NEW,k1:OLD` (new key first).
3. Tokens are re-encrypted with `k2` whenever Shopify refreshes them. Once every shop has
   re-authenticated or refreshed (expiring offline tokens refresh regularly), remove `k1`.

If a key is lost, affected shops are asked to re-authenticate automatically; no data is lost.

## If the database is exposed

1. Rotate `SHOPIFY_API_SECRET` (invalidates stolen OAuth material) and `TOKEN_ENCRYPTION_KEYS`.
2. Delete all rows in `Session`; merchants re-authenticate on next open.
3. The database holds no customer data — only shop domains, sale settings and variant prices.

## Data retention

- `shop/redact` (48 h after uninstall) deletes all data for the shop.
- `customers/*` privacy webhooks: no customer data is stored.
- Audit log rows record what happened to each sale (created, started, ended…) for merchant support. They
  store no user identity or personal data, and are deleted with the shop.

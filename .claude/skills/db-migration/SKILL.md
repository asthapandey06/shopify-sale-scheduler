---
description: Creates and applies a Prisma (PostgreSQL) database migration for PriceTide safely. Use when a task needs a new table, column, index or schema change, or when the user mentions Prisma, migrations, or the database schema.
disable-model-invocation: true
---

# Database migration

Schema changes are hard to undo once deployed. The owner must approve the change before you start.

## Steps

1. Confirm the owner approved the schema change and why it's needed.
2. Edit `prisma/schema.prisma`.
   - Keep the `Session` model compatible with `@shopify/shopify-app-session-storage-prisma`.
   - New columns on existing tables must be nullable or have a default (existing rows!).
   - Add indexes for any new query filter (`shop`, `status`, time columns).
3. Create the migration (uses DATABASE_URL from `.env`, the Neon dev database):
   ```bash
   npx prisma migrate dev --name <short_snake_case_description>
   ```
4. Read the generated `prisma/migrations/<timestamp>_<name>/migration.sql` and check it does
   what you expect — no unintended DROP of tables/columns.
5. Update code that uses the model:
   - `app/services/sale-repo.server.ts` (Prisma)
   - `app/lib/memory-repo.ts` (test double) if repo behaviour changed
   - Purge logic in `app/services/sales.server.ts` (`purgeShopData`) for any new shop-scoped table,
     so `shop/redact` still deletes all shop data.
6. Run the `verify-change` skill.
7. Commit the schema **and** the migration folder together.

## Never

- Edit or delete an already-applied migration.
- Use `prisma db push` or `migrate reset` against a database with real data.
- Store customer personal data (the app is designed to hold none).

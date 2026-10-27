-- DropIndex
DROP INDEX "Sale_shop_createdAt_idx";

-- CreateIndex
CREATE INDEX "Sale_shop_startsAt_idx" ON "Sale"("shop", "startsAt");

-- Surplus-food rescue: optional mode on donation listings.
-- Additive and backward compatible: the previous revision never writes these
-- columns, the defaults keep its inserts valid, and its selects name columns.
ALTER TABLE "listings"
  ADD COLUMN "food_rescue" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "collect_by" TIMESTAMPTZ(3),
  ADD COLUMN "food_prepared_at" TIMESTAMPTZ(3),
  ADD COLUMN "food_storage" VARCHAR(300),
  ADD COLUMN "food_allergens" VARCHAR(300),
  ADD COLUMN "food_expired_at" TIMESTAMPTZ(3);

-- A food offer is a donation with a deadline; null detail columns mean "unknown".
ALTER TABLE "listings" ADD CONSTRAINT "listings_food_rescue_shape"
  CHECK (NOT "food_rescue" OR ("collect_by" IS NOT NULL AND "mode" = 'donate'));
ALTER TABLE "listings" ADD CONSTRAINT "listings_food_prepared_before_deadline"
  CHECK ("food_prepared_at" IS NULL OR "collect_by" IS NULL OR "food_prepared_at" <= "collect_by");
ALTER TABLE "listings" ADD CONSTRAINT "listings_food_columns_only_for_food"
  CHECK ("food_rescue" OR ("collect_by" IS NULL AND "food_prepared_at" IS NULL AND "food_storage" IS NULL AND "food_allergens" IS NULL AND "food_expired_at" IS NULL));

-- Maintenance scans only food offers whose expiry has not been processed.
CREATE INDEX "listings_food_pending_expiry_idx" ON "listings" ("collect_by") WHERE "food_rescue" AND "food_expired_at" IS NULL;

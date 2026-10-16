-- Review-source observations recorded before they were per workspace cannot be attributed: drop them (they expire
-- within 30 days anyway, and only a trend is lost).
DELETE FROM "business_rating_observations" WHERE "source" <> 'golden_record';--> statement-breakpoint
ALTER TABLE "business_rating_observations" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "business_rating_observations" ADD CONSTRAINT "fk_business_rating_observations__organization_id" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_business_rating_observations__organization_id" ON "business_rating_observations" USING btree ("organization_id") WHERE "business_rating_observations"."organization_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "business_rating_observations" ADD CONSTRAINT "ck_business_rating_observations__organization" CHECK (("business_rating_observations"."source" = 'golden_record') = ("business_rating_observations"."organization_id" IS NULL));
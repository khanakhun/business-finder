ALTER TABLE "site_assets" DROP CONSTRAINT "ck_site_assets__license";--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "dhash" text;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "ownership" jsonb;--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "analysis" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_assets__site_id_source_url" ON "site_assets" USING btree ("site_id","source_url") WHERE "site_assets"."source_url" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "ck_site_assets__source" CHECK ("site_assets"."source" IN ('upload', 'owner_site', 'stock', 'ai', 'wordmark'));--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "ck_site_assets__kind" CHECK ("site_assets"."kind" IN ('image', 'logo'));--> statement-breakpoint
ALTER TABLE "site_assets" ADD CONSTRAINT "ck_site_assets__license" CHECK ("site_assets"."license" IN ('owner_site', 'stock', 'ai_generated', 'uploaded', 'system_generated'));
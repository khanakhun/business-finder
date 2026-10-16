CREATE TABLE "site_view_hours" (
	"site_id" uuid NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_site_view_hours" PRIMARY KEY("site_id","hour_start")
);
--> statement-breakpoint
ALTER TABLE "site_assets" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "thumbnails" jsonb;--> statement-breakpoint
ALTER TABLE "site_view_hours" ADD CONSTRAINT "site_view_hours_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_site_assets__processing" ON "site_assets" USING btree ("processing_started_at") WHERE "site_assets"."status" = 'processing';
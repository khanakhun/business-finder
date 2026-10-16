CREATE TABLE "site_fact_extractions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"snapshot_id" uuid,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"facts" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_fact_extractions" ADD CONSTRAINT "site_fact_extractions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_fact_extractions" ADD CONSTRAINT "site_fact_extractions_snapshot_id_website_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."website_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_fact_extractions__business_id_input_hash" ON "site_fact_extractions" USING btree ("business_id","input_hash");--> statement-breakpoint
CREATE INDEX "idx_site_fact_extractions__business_id_created_at" ON "site_fact_extractions" USING btree ("business_id","created_at" DESC NULLS LAST);
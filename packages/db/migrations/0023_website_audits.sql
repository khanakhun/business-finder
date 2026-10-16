CREATE TABLE "website_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"psi" jsonb,
	"vision" jsonb,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_score" smallint,
	"website_status" text NOT NULL,
	"is_latest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_website_audits__website_status" CHECK ("website_audits"."website_status" IN ('none', 'parked', 'social_only', 'broken', 'weak', 'ok', 'strong')),
	CONSTRAINT "ck_website_audits__quality_score" CHECK ("website_audits"."quality_score" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "website_audits" ADD CONSTRAINT "website_audits_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_audits" ADD CONSTRAINT "website_audits_snapshot_id_website_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."website_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_website_audits__snapshot_id" ON "website_audits" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_website_audits__business_id_latest" ON "website_audits" USING btree ("business_id") WHERE "website_audits"."is_latest";
CREATE TABLE "enrichment_email_verdicts" (
	"email_hash" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"details" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inconclusive_streak" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "ck_enrichment_email_verdicts__status" CHECK ("enrichment_email_verdicts"."status" IN ('unknown', 'valid', 'invalid', 'catch_all', 'risky', 'disposable')),
	CONSTRAINT "ck_enrichment_email_verdicts__email_hash" CHECK ("enrichment_email_verdicts"."email_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "verification_details" jsonb;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "published_context" jsonb;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "is_free_mail" boolean;--> statement-breakpoint
ALTER TABLE "enrichment_steps" ADD COLUMN "deferrals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_enrichment_email_verdicts__expires_at" ON "enrichment_email_verdicts" USING btree ("expires_at");
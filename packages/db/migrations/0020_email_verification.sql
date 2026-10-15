CREATE TABLE "email_verification_cache" (
	"email" "citext" PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"details" jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inconclusive_streak" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "ck_email_verification_cache__status" CHECK ("email_verification_cache"."status" IN ('unknown', 'valid', 'invalid', 'catch_all', 'risky', 'disposable'))
);
--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "verification_details" jsonb;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "published_context" jsonb;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD COLUMN "is_free_mail" boolean;
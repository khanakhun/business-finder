CREATE TABLE "business_rating_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"source" text NOT NULL,
	"avg" real NOT NULL,
	"count" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "ck_business_rating_observations__source" CHECK ("business_rating_observations"."source" IN ('google_places', 'gmaps_scraper', 'golden_record')),
	CONSTRAINT "ck_business_rating_observations__avg" CHECK ("business_rating_observations"."avg" BETWEEN 0 AND 5),
	CONSTRAINT "ck_business_rating_observations__count" CHECK ("business_rating_observations"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_insights" (
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"sources" text[] NOT NULL,
	"sample_size" integer NOT NULL,
	"pain_counts" jsonb NOT NULL,
	"pain_share" jsonb NOT NULL,
	"sentiment_avg" real,
	"owner_response_rate" real,
	"rating_snapshot" jsonb,
	"rating_trend" text DEFAULT 'unknown' NOT NULL,
	"evidence" jsonb NOT NULL,
	"source_stats" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_insights_organization_id_business_id_pk" PRIMARY KEY("organization_id","business_id"),
	CONSTRAINT "ck_review_insights__rating_trend" CHECK ("review_insights"."rating_trend" IN ('up', 'flat', 'down', 'unknown')),
	CONSTRAINT "ck_review_insights__sample_size" CHECK ("review_insights"."sample_size" >= 0),
	CONSTRAINT "ck_review_insights__sentiment_avg" CHECK ("review_insights"."sentiment_avg" BETWEEN -1 AND 1),
	CONSTRAINT "ck_review_insights__owner_response_rate" CHECK ("review_insights"."owner_response_rate" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "review_source_settings" (
	"organization_id" uuid NOT NULL,
	"source" text NOT NULL,
	"usage" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_source_settings_organization_id_source_pk" PRIMARY KEY("organization_id","source"),
	CONSTRAINT "ck_review_source_settings__source" CHECK ("review_source_settings"."source" IN ('google_places', 'gmaps_scraper', 'manual')),
	CONSTRAINT "ck_review_source_settings__usage" CHECK ("review_source_settings"."usage" IN ('none', 'transient_insights', 'store_text'))
);
--> statement-breakpoint
ALTER TABLE "enrichment_steps" DROP CONSTRAINT "ck_enrichment_steps__skip_reason";--> statement-breakpoint
ALTER TABLE "business_rating_observations" ADD CONSTRAINT "business_rating_observations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_insights" ADD CONSTRAINT "review_insights_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_insights" ADD CONSTRAINT "review_insights_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_source_settings" ADD CONSTRAINT "review_source_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_source_settings" ADD CONSTRAINT "review_source_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_business_rating_observations__business_id_observed_at" ON "business_rating_observations" USING btree ("business_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_business_rating_observations__expires_at" ON "business_rating_observations" USING btree ("expires_at") WHERE "business_rating_observations"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_review_insights__business_id" ON "review_insights" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_review_insights__expires_at" ON "review_insights" USING btree ("expires_at") WHERE "review_insights"."expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_steps" ADD CONSTRAINT "ck_enrichment_steps__skip_reason" CHECK ("enrichment_steps"."skip_reason" IS NULL OR "enrichment_steps"."skip_reason" IN ('fresh', 'no_website', 'not_applicable', 'dependency_failed', 'dependency_skipped', 'budget', 'cancelled', 'not_registered', 'licensing_disabled')) NOT VALID;--> statement-breakpoint
-- A superset of the old list: validated without blocking writes (SHARE UPDATE EXCLUSIVE lock).
ALTER TABLE "enrichment_steps" VALIDATE CONSTRAINT "ck_enrichment_steps__skip_reason";

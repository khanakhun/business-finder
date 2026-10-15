CREATE TABLE "category_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_key" text NOT NULL,
	"provider_label" text,
	"category_id" uuid NOT NULL,
	"confidence" real NOT NULL,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"rationale" text,
	"seed_version" integer,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_category_mappings__provider" CHECK ("category_mappings"."provider" IN ('google_places', 'overture', 'foursquare', 'osm')),
	CONSTRAINT "ck_category_mappings__origin" CHECK ("category_mappings"."origin" IN ('seed', 'llm', 'human')),
	CONSTRAINT "ck_category_mappings__status" CHECK ("category_mappings"."status" IN ('active', 'needs_review', 'rejected')),
	CONSTRAINT "ck_category_mappings__confidence" CHECK ("category_mappings"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "ck_category_mappings__provider_key" CHECK (length("category_mappings"."provider_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "app_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "synonyms" jsonb DEFAULT '{"en":[],"fr":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "attributes" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "offer_relevance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "search_text" text GENERATED ALWAYS AS (f_unaccent(lower(coalesce(labels->>'en', '') || ' ' || coalesce(labels->>'fr', '') || ' ' || synonyms::text))) STORED;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_mappings" ADD CONSTRAINT "category_mappings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_category_mappings__provider_provider_key" ON "category_mappings" USING btree ("provider","provider_key");--> statement-breakpoint
CREATE INDEX "idx_category_mappings__category_id" ON "category_mappings" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_category_mappings__status_created_at" ON "category_mappings" USING btree ("status","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_categories__path" ON "categories" USING gist ("path");--> statement-breakpoint
CREATE INDEX "idx_categories__search_text" ON "categories" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories__slug" CHECK ("categories"."slug" ~ '^[a-z0-9_]{1,40}$');--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories__depth" CHECK (nlevel("categories"."path") BETWEEN 1 AND 4);--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER category_mappings_set_updated_at BEFORE UPDATE ON "category_mappings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

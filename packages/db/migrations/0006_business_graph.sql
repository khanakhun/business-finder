CREATE TABLE "business_categories" (
	"business_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"confidence" real NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_categories_business_id_category_id_pk" PRIMARY KEY("business_id","category_id"),
	CONSTRAINT "ck_business_categories__confidence" CHECK ("business_categories"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "business_contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"type" text NOT NULL,
	"value" text NOT NULL,
	"normalized_value" "citext" NOT NULL,
	"subtype" text DEFAULT 'unknown' NOT NULL,
	"person_name" text,
	"source" text NOT NULL,
	"source_url" text,
	"published_on_site" boolean DEFAULT false NOT NULL,
	"confidence" real NOT NULL,
	"submitted_by_org_id" uuid,
	"verification_status" text DEFAULT 'unknown' NOT NULL,
	"verified_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_business_contacts__source" CHECK ("business_contacts"."source" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'website', 'manual', 'import')),
	CONSTRAINT "ck_business_contacts__type" CHECK ("business_contacts"."type" IN ('email', 'phone', 'whatsapp', 'website_form', 'social')),
	CONSTRAINT "ck_business_contacts__verification_status" CHECK ("business_contacts"."verification_status" IN ('unknown', 'valid', 'invalid', 'catch_all', 'risky', 'disposable')),
	CONSTRAINT "ck_business_contacts__confidence" CHECK ("business_contacts"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"business_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "business_hours_business_id_weekday_opens_at_pk" PRIMARY KEY("business_id","weekday","opens_at"),
	CONSTRAINT "ck_business_hours__source" CHECK ("business_hours"."source" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'website', 'manual', 'import')),
	CONSTRAINT "ck_business_hours__weekday" CHECK ("business_hours"."weekday" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE TABLE "business_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text,
	"external_url" text,
	"source" text NOT NULL,
	"license" text DEFAULT 'unknown' NOT NULL,
	"width" integer,
	"height" integer,
	"dominant_colors" jsonb,
	"alt_text" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_business_media__source" CHECK ("business_media"."source" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'website', 'manual', 'import')),
	CONSTRAINT "ck_business_media__kind" CHECK ("business_media"."kind" IN ('photo', 'logo', 'screenshot_desktop', 'screenshot_mobile', 'og_image')),
	CONSTRAINT "ck_business_media__license" CHECK ("business_media"."license" IN ('owner_site', 'provider_restricted', 'stock', 'ai_generated', 'unknown')),
	CONSTRAINT "ck_business_media__location" CHECK ("business_media"."storage_key" IS NOT NULL OR "business_media"."external_url" IS NOT NULL),
	CONSTRAINT "ck_business_media__dimensions" CHECK ("business_media"."width" > 0 AND "business_media"."height" > 0)
);
--> statement-breakpoint
CREATE TABLE "business_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"rating" smallint,
	"text" text,
	"language" text,
	"published_at" timestamp with time zone,
	"has_owner_response" boolean DEFAULT false NOT NULL,
	"owner_responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_business_reviews__source" CHECK ("business_reviews"."source" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'website', 'manual', 'import')),
	CONSTRAINT "ck_business_reviews__rating" CHECK ("business_reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "business_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"normalized" jsonb,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"match_confidence" real,
	"linked_by" text DEFAULT 'auto' NOT NULL,
	"submitted_by_org_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_business_sources__provider" CHECK ("business_sources"."provider" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'website', 'manual', 'import')),
	CONSTRAINT "ck_business_sources__linked_by" CHECK ("business_sources"."linked_by" IN ('auto', 'manual')),
	CONSTRAINT "ck_business_sources__match_confidence" CHECK ("business_sources"."match_confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
-- Drizzle Kit quotes parameterized custom types ("geography(Point,4326)"); unquoted by hand.
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"primary_category_id" uuid,
	"operating_status" text DEFAULT 'unknown' NOT NULL,
	"website_url" text,
	"website_host" text,
	"website_registrable_domain" text,
	"primary_phone_e164" text,
	"country_code" text,
	"locale_hint" text,
	"location" geography(Point,4326),
	"address" jsonb,
	"formatted_address" text,
	"locality" text,
	"postal_code" text,
	"price_level" smallint,
	"rating_avg" numeric(2, 1),
	"rating_count" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_quality" smallint,
	"merged_into_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_businesses__operating_status" CHECK ("businesses"."operating_status" IN ('operational', 'closed_temporarily', 'closed_permanently', 'unknown')),
	CONSTRAINT "ck_businesses__price_level" CHECK ("businesses"."price_level" BETWEEN 0 AND 4),
	CONSTRAINT "ck_businesses__rating_avg" CHECK ("businesses"."rating_avg" BETWEEN 0 AND 5),
	CONSTRAINT "ck_businesses__rating_count" CHECK ("businesses"."rating_count" >= 0),
	CONSTRAINT "ck_businesses__data_quality" CHECK ("businesses"."data_quality" BETWEEN 0 AND 100),
	CONSTRAINT "ck_businesses__country_code" CHECK ("businesses"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "ck_businesses__version" CHECK ("businesses"."version" >= 0),
	CONSTRAINT "ck_businesses__not_merged_into_self" CHECK ("businesses"."merged_into_id" <> "businesses"."id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"parent_id" uuid,
	"path" "ltree" NOT NULL,
	"labels" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "possible_duplicates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_a_id" uuid NOT NULL,
	"business_b_id" uuid NOT NULL,
	"score" real NOT NULL,
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_possible_duplicates__ordered_pair" CHECK ("possible_duplicates"."business_a_id" < "possible_duplicates"."business_b_id"),
	CONSTRAINT "ck_possible_duplicates__status" CHECK ("possible_duplicates"."status" IN ('open', 'merged', 'dismissed')),
	CONSTRAINT "ck_possible_duplicates__score" CHECK ("possible_duplicates"."score" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "org_businesses" (
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"pipeline_status" text DEFAULT 'new' NOT NULL,
	"added_via" text NOT NULL,
	"added_ref" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_businesses_organization_id_business_id_pk" PRIMARY KEY("organization_id","business_id"),
	CONSTRAINT "ck_org_businesses__pipeline_status" CHECK ("org_businesses"."pipeline_status" IN ('new', 'qualified', 'disqualified', 'contacted', 'engaged', 'meeting', 'proposal', 'won', 'lost')),
	CONSTRAINT "ck_org_businesses__added_via" CHECK ("org_businesses"."added_via" IN ('discovery', 'search', 'manual', 'import'))
);
--> statement-breakpoint
ALTER TABLE "business_categories" ADD CONSTRAINT "business_categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_categories" ADD CONSTRAINT "business_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD CONSTRAINT "business_contacts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_contacts" ADD CONSTRAINT "business_contacts_submitted_by_org_id_organizations_id_fk" FOREIGN KEY ("submitted_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_media" ADD CONSTRAINT "business_media_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_reviews" ADD CONSTRAINT "business_reviews_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_sources" ADD CONSTRAINT "business_sources_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_sources" ADD CONSTRAINT "business_sources_submitted_by_org_id_organizations_id_fk" FOREIGN KEY ("submitted_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_primary_category_id_categories_id_fk" FOREIGN KEY ("primary_category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_merged_into_id_businesses_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "possible_duplicates" ADD CONSTRAINT "possible_duplicates_business_a_id_businesses_id_fk" FOREIGN KEY ("business_a_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "possible_duplicates" ADD CONSTRAINT "possible_duplicates_business_b_id_businesses_id_fk" FOREIGN KEY ("business_b_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD CONSTRAINT "org_businesses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD CONSTRAINT "org_businesses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_categories__business_id_primary" ON "business_categories" USING btree ("business_id") WHERE "business_categories"."is_primary";--> statement-breakpoint
CREATE INDEX "idx_business_categories__category_id" ON "business_categories" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_contacts__business_id_type_normalized_value" ON "business_contacts" USING btree ("business_id","type","normalized_value");--> statement-breakpoint
CREATE INDEX "idx_business_contacts__type_normalized_value" ON "business_contacts" USING btree ("type","normalized_value");--> statement-breakpoint
CREATE INDEX "idx_business_media__business_id" ON "business_media" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_reviews__source_external_id" ON "business_reviews" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "idx_business_reviews__business_id_published_at" ON "business_reviews" USING btree ("business_id","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_business_sources__provider_provider_ref" ON "business_sources" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE INDEX "idx_business_sources__business_id" ON "business_sources" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_business_sources__expires_at" ON "business_sources" USING btree ("expires_at") WHERE "business_sources"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_businesses__location" ON "businesses" USING gist ("location");--> statement-breakpoint
CREATE INDEX "idx_businesses__normalized_name" ON "businesses" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_businesses__website_registrable_domain" ON "businesses" USING btree ("website_registrable_domain");--> statement-breakpoint
CREATE INDEX "idx_businesses__website_host" ON "businesses" USING btree ("website_host");--> statement-breakpoint
CREATE INDEX "idx_businesses__primary_phone_e164" ON "businesses" USING btree ("primary_phone_e164");--> statement-breakpoint
CREATE INDEX "idx_businesses__country_code" ON "businesses" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "idx_businesses__locality" ON "businesses" USING btree ("locality");--> statement-breakpoint
CREATE INDEX "idx_businesses__primary_category_id" ON "businesses" USING btree ("primary_category_id");--> statement-breakpoint
CREATE INDEX "idx_businesses__merged_into_id" ON "businesses" USING btree ("merged_into_id") WHERE "businesses"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_categories__slug" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_categories__parent_id" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_possible_duplicates__business_a_id_business_b_id" ON "possible_duplicates" USING btree ("business_a_id","business_b_id");--> statement-breakpoint
CREATE INDEX "idx_possible_duplicates__business_b_id" ON "possible_duplicates" USING btree ("business_b_id");--> statement-breakpoint
CREATE INDEX "idx_possible_duplicates__open" ON "possible_duplicates" USING btree ("created_at") WHERE "possible_duplicates"."status" = 'open';--> statement-breakpoint
CREATE INDEX "idx_org_businesses__organization_id_pipeline_status" ON "org_businesses" USING btree ("organization_id","pipeline_status");--> statement-breakpoint
CREATE INDEX "idx_org_businesses__organization_id_created_at" ON "org_businesses" USING btree ("organization_id","created_at" DESC NULLS LAST,"business_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_org_businesses__business_id" ON "org_businesses" USING btree ("business_id");--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER categories_set_updated_at BEFORE UPDATE ON "categories" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER businesses_set_updated_at BEFORE UPDATE ON "businesses" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER business_sources_set_updated_at BEFORE UPDATE ON "business_sources" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER business_contacts_set_updated_at BEFORE UPDATE ON "business_contacts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER business_categories_set_updated_at BEFORE UPDATE ON "business_categories" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER possible_duplicates_set_updated_at BEFORE UPDATE ON "possible_duplicates" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER org_businesses_set_updated_at BEFORE UPDATE ON "org_businesses" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

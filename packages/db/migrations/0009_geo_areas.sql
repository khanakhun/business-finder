-- Drizzle Kit quotes parameterized custom types; unquoted by hand (see 0006).
CREATE TABLE "geo_areas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"country_code" text,
	"code" text,
	"name" jsonb NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"normalized_names" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"search_text" text NOT NULL,
	"parent_id" uuid,
	"geom" geography(MultiPolygon,4326) NOT NULL,
	"centroid" geography(Point,4326),
	"approximate" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"area_km2" real,
	"organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_geo_areas__kind" CHECK ("geo_areas"."kind" IN ('country', 'admin1', 'admin2', 'locality', 'district', 'postal_code', 'island', 'custom')),
	CONSTRAINT "ck_geo_areas__source" CHECK ("geo_areas"."source" IN ('osm', 'overture', 'census', 'pdok', 'custom', 'nominatim', 'google')),
	CONSTRAINT "ck_geo_areas__country_code" CHECK ("geo_areas"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "ck_geo_areas__custom_owner" CHECK (("geo_areas"."kind" = 'custom') = ("geo_areas"."organization_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "geocode_cache" (
	"query_normalized" text NOT NULL,
	"provider" text NOT NULL,
	"country_hint" text DEFAULT '' NOT NULL,
	"locale" text DEFAULT '' NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "geocode_cache_pkey" PRIMARY KEY("query_normalized","provider","country_hint","locale","scope")
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "default_country_code" text;--> statement-breakpoint
ALTER TABLE "geo_areas" ADD CONSTRAINT "geo_areas_parent_id_geo_areas_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."geo_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_areas" ADD CONSTRAINT "geo_areas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_geo_areas__source_source_ref" ON "geo_areas" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__geom" ON "geo_areas" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__search_text" ON "geo_areas" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_geo_areas__normalized_names" ON "geo_areas" USING gin ("normalized_names");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__country_code_kind" ON "geo_areas" USING btree ("country_code","kind");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__kind_code" ON "geo_areas" USING btree ("kind","code");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__parent_id" ON "geo_areas" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_geo_areas__organization_id" ON "geo_areas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_geocode_cache__expires_at" ON "geocode_cache" USING btree ("expires_at");--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER geo_areas_set_updated_at BEFORE UPDATE ON "geo_areas" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

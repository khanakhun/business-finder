CREATE TABLE "business_score_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"score" smallint NOT NULL,
	"tier" text NOT NULL,
	"contributions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"gated" jsonb,
	"features" jsonb NOT NULL,
	"feature_set_version" integer NOT NULL,
	"facts_hash" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ck_business_score_history__score" CHECK ("business_score_history"."score" BETWEEN 0 AND 100),
	CONSTRAINT "ck_business_score_history__tier" CHECK ("business_score_history"."tier" IN ('A', 'B', 'C', 'X'))
);
--> statement-breakpoint
CREATE TABLE "business_scores" (
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_version" integer NOT NULL,
	"score" smallint NOT NULL,
	"tier" text NOT NULL,
	"contributions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"gated" jsonb,
	"features" jsonb NOT NULL,
	"feature_set_version" integer NOT NULL,
	"facts_hash" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "business_scores_pkey" PRIMARY KEY("organization_id","business_id","profile_id"),
	CONSTRAINT "ck_business_scores__score" CHECK ("business_scores"."score" BETWEEN 0 AND 100),
	CONSTRAINT "ck_business_scores__tier" CHECK ("business_scores"."tier" IN ('A', 'B', 'C', 'X'))
);
--> statement-breakpoint
CREATE TABLE "scoring_profile_versions" (
	"profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_profile_versions_profile_id_version_pk" PRIMARY KEY("profile_id","version"),
	CONSTRAINT "ck_scoring_profile_versions__version" CHECK ("scoring_profile_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "scoring_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"offer" text NOT NULL,
	"name" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"active_version" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_scoring_profiles__offer" CHECK ("scoring_profiles"."offer" IN ('new_website', 'website_redesign', 'ai_receptionist', 'booking_system', 'local_seo')),
	CONSTRAINT "ck_scoring_profiles__builtin" CHECK ("scoring_profiles"."builtin" = ("scoring_profiles"."organization_id" IS NULL)),
	CONSTRAINT "ck_scoring_profiles__active_version" CHECK ("scoring_profiles"."active_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "scoring_workspace_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"primary_profile_id" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_score_history" ADD CONSTRAINT "business_score_history_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_score_history" ADD CONSTRAINT "fk_business_score_history__organization_id" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_score_history" ADD CONSTRAINT "fk_business_score_history__profile_version" FOREIGN KEY ("profile_id","profile_version") REFERENCES "public"."scoring_profile_versions"("profile_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_scores" ADD CONSTRAINT "business_scores_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_scores" ADD CONSTRAINT "fk_business_scores__organization_id" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_scores" ADD CONSTRAINT "fk_business_scores__profile_version" FOREIGN KEY ("profile_id","profile_version") REFERENCES "public"."scoring_profile_versions"("profile_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profile_versions" ADD CONSTRAINT "scoring_profile_versions_profile_id_scoring_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."scoring_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profile_versions" ADD CONSTRAINT "scoring_profile_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profiles" ADD CONSTRAINT "scoring_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profiles" ADD CONSTRAINT "scoring_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_workspace_settings" ADD CONSTRAINT "scoring_workspace_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_workspace_settings" ADD CONSTRAINT "scoring_workspace_settings_primary_profile_id_scoring_profiles_id_fk" FOREIGN KEY ("primary_profile_id") REFERENCES "public"."scoring_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_workspace_settings" ADD CONSTRAINT "scoring_workspace_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_business_score_history__org_business_profile_computed_at" ON "business_score_history" USING btree ("organization_id","business_id","profile_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_business_score_history__business_id" ON "business_score_history" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_business_score_history__profile_id" ON "business_score_history" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_business_scores__organization_id_profile_id_score" ON "business_scores" USING btree ("organization_id","profile_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_business_scores__business_id" ON "business_scores" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "idx_business_scores__profile_id" ON "business_scores" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_scoring_profiles__organization_id" ON "scoring_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scoring_profiles__builtin_offer" ON "scoring_profiles" USING btree ("offer") WHERE "scoring_profiles"."builtin";--> statement-breakpoint
CREATE TRIGGER scoring_profiles_set_updated_at BEFORE UPDATE ON "scoring_profiles" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER scoring_workspace_settings_set_updated_at BEFORE UPDATE ON "scoring_workspace_settings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Profile versions and score history are never rewritten (BF-031): scores name the version they used, and the
-- outcome model (BF-059) trains on the history. Deletes stay possible (a workspace or business deleted cascades).
CREATE OR REPLACE FUNCTION scoring_rows_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER scoring_profile_versions_immutable BEFORE UPDATE ON "scoring_profile_versions" FOR EACH ROW EXECUTE FUNCTION scoring_rows_immutable();--> statement-breakpoint
CREATE TRIGGER business_score_history_immutable BEFORE UPDATE ON "business_score_history" FOR EACH ROW EXECUTE FUNCTION scoring_rows_immutable();

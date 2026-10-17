CREATE TABLE "business_score_shadows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"probability" double precision NOT NULL,
	"score" smallint NOT NULL,
	"tier" text NOT NULL,
	"contributions" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"facts_hash" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_shadow_assignments" (
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_shadow_assignments_organization_id_profile_id_pk" PRIMARY KEY("organization_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "business_score_shadows" ADD CONSTRAINT "business_score_shadows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_score_shadows" ADD CONSTRAINT "business_score_shadows_model_id_scoring_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."scoring_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_shadow_assignments" ADD CONSTRAINT "scoring_shadow_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_shadow_assignments" ADD CONSTRAINT "scoring_shadow_assignments_model_id_scoring_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."scoring_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_shadow_assignments" ADD CONSTRAINT "scoring_shadow_assignments_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_business_score_shadows__latest" ON "business_score_shadows" USING btree ("organization_id","business_id","profile_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_business_score_shadows__model" ON "business_score_shadows" USING btree ("model_id","computed_at");
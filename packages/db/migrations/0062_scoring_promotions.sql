CREATE TABLE "scoring_model_monitoring" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature_psi" jsonb NOT NULL,
	"score_psi" double precision,
	"auc" double precision,
	"validation_auc" double precision,
	"recent_contacts" integer NOT NULL,
	"alerts" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_model_promotions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"eligible" boolean NOT NULL,
	"override_reason" text,
	"comparison" jsonb,
	"promoted_by" uuid,
	"promoted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rolled_back_by" uuid,
	"rolled_back_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "scoring_model_monitoring" ADD CONSTRAINT "scoring_model_monitoring_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_model_monitoring" ADD CONSTRAINT "scoring_model_monitoring_model_id_scoring_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."scoring_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_model_promotions" ADD CONSTRAINT "scoring_model_promotions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_model_promotions" ADD CONSTRAINT "scoring_model_promotions_model_id_scoring_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."scoring_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_model_promotions" ADD CONSTRAINT "scoring_model_promotions_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_model_promotions" ADD CONSTRAINT "scoring_model_promotions_rolled_back_by_users_id_fk" FOREIGN KEY ("rolled_back_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_scoring_model_monitoring__model" ON "scoring_model_monitoring" USING btree ("model_id","at");--> statement-breakpoint
CREATE INDEX "ix_scoring_model_promotions__profile" ON "scoring_model_promotions" USING btree ("organization_id","profile_id","promoted_at");
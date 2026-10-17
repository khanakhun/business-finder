CREATE TABLE "ml_training_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"consider_gbm" boolean DEFAULT true NOT NULL,
	"error" text,
	"model_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scoring_models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"offer" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'trained' NOT NULL,
	"dataset_id" uuid NOT NULL,
	"label_version" integer NOT NULL,
	"artifact_keys" jsonb NOT NULL,
	"artifact_hashes" jsonb NOT NULL,
	"model_card" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"baseline_metrics" jsonb NOT NULL,
	"spearman" double precision,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trained_by" uuid,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_by" uuid,
	"promoted_at" timestamp with time zone,
	CONSTRAINT "ck_scoring_models__status" CHECK ("scoring_models"."status" IN ('trained', 'shadow', 'active', 'retired', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "ml_training_runs" ADD CONSTRAINT "ml_training_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_training_runs" ADD CONSTRAINT "ml_training_runs_dataset_id_ml_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."ml_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_training_runs" ADD CONSTRAINT "ml_training_runs_model_id_scoring_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."scoring_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_training_runs" ADD CONSTRAINT "ml_training_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_models" ADD CONSTRAINT "scoring_models_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_models" ADD CONSTRAINT "scoring_models_dataset_id_ml_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."ml_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_models" ADD CONSTRAINT "scoring_models_trained_by_users_id_fk" FOREIGN KEY ("trained_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_models" ADD CONSTRAINT "scoring_models_promoted_by_users_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ml_training_runs__org_created" ON "ml_training_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scoring_models__org_offer_version" ON "scoring_models" USING btree ("organization_id","offer","version");--> statement-breakpoint
-- BF-059: a trained model is immutable; only its status and promotion stamp may change (and `trained_by`,
-- which a deleted member's account sets to null).
CREATE OR REPLACE FUNCTION bf_scoring_models_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.offer IS DISTINCT FROM OLD.offer
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.dataset_id IS DISTINCT FROM OLD.dataset_id
    OR NEW.label_version IS DISTINCT FROM OLD.label_version
    OR NEW.artifact_keys IS DISTINCT FROM OLD.artifact_keys
    OR NEW.artifact_hashes IS DISTINCT FROM OLD.artifact_hashes
    OR NEW.model_card IS DISTINCT FROM OLD.model_card
    OR NEW.metrics IS DISTINCT FROM OLD.metrics
    OR NEW.baseline_metrics IS DISTINCT FROM OLD.baseline_metrics
    OR NEW.spearman IS DISTINCT FROM OLD.spearman
    OR NEW.warnings IS DISTINCT FROM OLD.warnings
    OR NEW.trained_at IS DISTINCT FROM OLD.trained_at THEN
    RAISE EXCEPTION 'scoring_models rows are immutable once trained (only status and promotion change)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER bf_scoring_models_immutable BEFORE UPDATE ON "scoring_models"
  FOR EACH ROW EXECUTE FUNCTION bf_scoring_models_immutable();

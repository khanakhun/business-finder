CREATE TABLE "ml_datasets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"offer" text NOT NULL,
	"label_version" integer NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"counts" jsonb NOT NULL,
	"features" jsonb NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ml_label_definitions" (
	"version" integer PRIMARY KEY NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ml_datasets" ADD CONSTRAINT "ml_datasets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_datasets" ADD CONSTRAINT "ml_datasets_label_version_ml_label_definitions_version_fk" FOREIGN KEY ("label_version") REFERENCES "public"."ml_label_definitions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ml_datasets" ADD CONSTRAINT "ml_datasets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ml_datasets__org_offer" ON "ml_datasets" USING btree ("organization_id","offer","created_at");--> statement-breakpoint
-- BF-059: label definition v1 (mirrors LABEL_DEFINITIONS[1] in scoring/domain/ml/label-definition.ts).
INSERT INTO "ml_label_definitions" ("version", "definition") VALUES (1, '{
  "horizonDays": 30,
  "positiveReplyClasses": ["interested", "question"],
  "positiveStages": ["engaged", "meeting", "proposal", "won"],
  "leadKinds": ["claim_interest", "contact_request"],
  "unit": "first contact of a business by the workspace for an offer",
  "excluded": "first email bounced"
}'::jsonb) ON CONFLICT DO NOTHING;

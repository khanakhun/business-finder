CREATE TABLE "fact_registry_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"facts" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_business_facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb NOT NULL,
	"locale" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "fact_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "bundle_hash" text;--> statement-breakpoint
ALTER TABLE "fact_registry_snapshots" ADD CONSTRAINT "fact_registry_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_registry_snapshots" ADD CONSTRAINT "fact_registry_snapshots_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_business_facts" ADD CONSTRAINT "org_business_facts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_business_facts" ADD CONSTRAINT "org_business_facts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_business_facts" ADD CONSTRAINT "org_business_facts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fact_registry_snapshots__org_business_hash" ON "fact_registry_snapshots" USING btree ("organization_id","business_id","content_hash");--> statement-breakpoint
CREATE INDEX "idx_org_business_facts__organization_id_business_id" ON "org_business_facts" USING btree ("organization_id","business_id") WHERE "org_business_facts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER org_business_facts_set_updated_at BEFORE UPDATE ON "org_business_facts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

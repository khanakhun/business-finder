CREATE TABLE "dsr_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"subject_sealed" text,
	"subject_hash" text,
	"received_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"verification" jsonb,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"export_key" text,
	"handled_by" uuid,
	"reminded_at" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dry_run" boolean NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" uuid
);
--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_dsr_requests__org_status" ON "dsr_requests" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ix_dsr_requests__due" ON "dsr_requests" USING btree ("due_at");--> statement-breakpoint
CREATE TRIGGER dsr_requests_set_updated_at BEFORE UPDATE ON "dsr_requests" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

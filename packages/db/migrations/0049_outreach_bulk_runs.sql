CREATE TABLE "outreach_bulk_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"offer" text NOT NULL,
	"purpose" text NOT NULL,
	"mode" text NOT NULL,
	"template_id" uuid,
	"locale" text NOT NULL,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"business_ids" uuid[] NOT NULL,
	"drafted" integer DEFAULT 0 NOT NULL,
	"skipped" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_bulk_runs" ADD CONSTRAINT "outreach_bulk_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_bulk_runs" ADD CONSTRAINT "outreach_bulk_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_outreach_bulk_runs__org_created" ON "outreach_bulk_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_bulk_run_id_outreach_bulk_runs_id_fk" FOREIGN KEY ("bulk_run_id") REFERENCES "public"."outreach_bulk_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER outreach_bulk_runs_set_updated_at BEFORE UPDATE ON "outreach_bulk_runs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- BF-052 part 3: approving a bulk message judges it again, so its enqueue decision may be replaced while it waits
-- for approval. Once queued (or later), both decisions are evidence: fixed (the send decision once sent or blocked).
CREATE OR REPLACE FUNCTION bf_outbound_decisions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enqueue_decision_id IS NOT NULL
      AND NEW.enqueue_decision_id IS DISTINCT FROM OLD.enqueue_decision_id
      AND OLD.status NOT IN ('draft', 'pending_approval'))
     OR (OLD.send_decision_id IS NOT NULL
         AND NEW.send_decision_id IS DISTINCT FROM OLD.send_decision_id
         AND OLD.status NOT IN ('queued', 'sending', 'failed')) THEN
    RAISE EXCEPTION 'outbound_messages: a compliance decision cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

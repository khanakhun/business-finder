CREATE TABLE "email_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"mailbox_id" uuid,
	"subject_root" text NOT NULL,
	"provider_thread_id" text,
	"root_message_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_contact_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"outcome" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"thread_id" uuid NOT NULL,
	"mailbox_id" uuid,
	"draft_id" uuid,
	"sequence_enrollment_id" uuid,
	"sequence_step" integer,
	"bulk_run_id" uuid,
	"purpose" text NOT NULL,
	"offer" text NOT NULL,
	"locale" text NOT NULL,
	"to_email" text,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unsubscribe_token_id" uuid,
	"outreach_token" text,
	"enqueue_decision_id" uuid,
	"send_decision_id" uuid,
	"lawful_basis_id" uuid,
	"footer_version" integer DEFAULT 1 NOT NULL,
	"blocked_reasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"rfc822_message_id" text NOT NULL,
	"provider_thread_id" text,
	"in_reply_to" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"status_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_outbound_messages__enqueue_decision" CHECK (status NOT IN ('queued','sending','sent','failed','blocked','bounced','replied') OR enqueue_decision_id IS NOT NULL),
	CONSTRAINT "ck_outbound_messages__send_decision" CHECK (status NOT IN ('sent','bounced','replied') OR send_decision_id IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contact_id_business_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."business_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD CONSTRAINT "manual_contact_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD CONSTRAINT "manual_contact_logs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD CONSTRAINT "manual_contact_logs_contact_id_business_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."business_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD CONSTRAINT "manual_contact_logs_decision_id_compliance_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."compliance_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD CONSTRAINT "manual_contact_logs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_contact_id_business_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."business_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_draft_id_email_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."email_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_enqueue_decision_id_compliance_decisions_id_fk" FOREIGN KEY ("enqueue_decision_id") REFERENCES "public"."compliance_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_send_decision_id_compliance_decisions_id_fk" FOREIGN KEY ("send_decision_id") REFERENCES "public"."compliance_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_email_threads__org_business" ON "email_threads" USING btree ("organization_id","business_id","last_message_at");--> statement-breakpoint
CREATE INDEX "ix_email_threads__root_message" ON "email_threads" USING btree ("root_message_id");--> statement-breakpoint
CREATE INDEX "ix_manual_contact_logs__org_business" ON "manual_contact_logs" USING btree ("organization_id","business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_messages__org_idempotency" ON "outbound_messages" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__due" ON "outbound_messages" USING btree ("status","scheduled_at") WHERE "outbound_messages"."status" IN ('queued','sending');--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__org_business" ON "outbound_messages" USING btree ("organization_id","business_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__org_status" ON "outbound_messages" USING btree ("organization_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__thread" ON "outbound_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_outbound_messages__rfc822" ON "outbound_messages" USING btree ("rfc822_message_id");--> statement-breakpoint
-- BF-052: keep updated_at current.
CREATE TRIGGER email_threads_set_updated_at BEFORE UPDATE ON "email_threads" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER outbound_messages_set_updated_at BEFORE UPDATE ON "outbound_messages" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A message's decisions are evidence: once set, neither may be replaced or cleared.
CREATE OR REPLACE FUNCTION bf_outbound_decisions_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.enqueue_decision_id IS NOT NULL AND NEW.enqueue_decision_id IS DISTINCT FROM OLD.enqueue_decision_id)
     OR (OLD.send_decision_id IS NOT NULL AND NEW.send_decision_id IS DISTINCT FROM OLD.send_decision_id) THEN
    RAISE EXCEPTION 'outbound_messages: a compliance decision cannot be replaced' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER outbound_messages_decisions_fixed BEFORE UPDATE ON "outbound_messages" FOR EACH ROW EXECUTE FUNCTION bf_outbound_decisions_fixed();

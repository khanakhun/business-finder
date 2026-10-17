CREATE TABLE "enrollment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step_id" text,
	"variant_id" text,
	"detail" text,
	"message_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_message_views" (
	"outbound_message_id" uuid NOT NULL,
	"first_viewed_at" timestamp with time zone NOT NULL,
	"last_viewed_at" timestamp with time zone NOT NULL,
	"views" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "outbound_message_views_outbound_message_id_pk" PRIMARY KEY("outbound_message_id")
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence_version_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"mailbox_id" uuid,
	"thread_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_index" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"waiting_message_id" uuid,
	"lease_until" timestamp with time zone,
	"variant_assignments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	"pause_reason" text,
	"stopped_at" timestamp with time zone,
	"enrolled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sequence_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"settings" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"offer" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"head_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_enrollment_id_sequence_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_events" ADD CONSTRAINT "enrollment_events_message_id_outbound_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_views" ADD CONSTRAINT "outbound_message_views_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_version_id_sequence_versions_id_fk" FOREIGN KEY ("sequence_version_id") REFERENCES "public"."sequence_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_business_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."business_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_waiting_message_id_outbound_messages_id_fk" FOREIGN KEY ("waiting_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_versions" ADD CONSTRAINT "sequence_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_enrollment_events__enrollment" ON "enrollment_events" USING btree ("enrollment_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sequence_enrollments__one_running" ON "sequence_enrollments" USING btree ("organization_id","business_id") WHERE "sequence_enrollments"."status" IN ('active','paused');--> statement-breakpoint
CREATE INDEX "ix_sequence_enrollments__due" ON "sequence_enrollments" USING btree ("status","next_run_at") WHERE "sequence_enrollments"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ix_sequence_enrollments__org_business" ON "sequence_enrollments" USING btree ("organization_id","business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sequence_versions__sequence_version" ON "sequence_versions" USING btree ("sequence_id","version");--> statement-breakpoint
CREATE INDEX "ix_sequences__org" ON "sequences" USING btree ("organization_id","status");--> statement-breakpoint
CREATE TRIGGER sequences_set_updated_at BEFORE UPDATE ON "sequences" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sequence_enrollments_set_updated_at BEFORE UPDATE ON "sequence_enrollments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A version is immutable once written (BF-053): editing a sequence creates the next version.
CREATE TRIGGER sequence_versions_immutable BEFORE UPDATE ON "sequence_versions" FOR EACH ROW EXECUTE FUNCTION bf_append_only();

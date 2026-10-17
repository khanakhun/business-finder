CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"outbound_message_id" uuid,
	"provider_message_id" text NOT NULL,
	"rfc822_message_id" text,
	"in_reply_to" text,
	"references" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"from_email" text,
	"from_name" text,
	"to" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"cc" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"subject" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"body_text" text NOT NULL,
	"body_html_sanitized" text,
	"has_remote_images" boolean DEFAULT false NOT NULL,
	"snippet" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"dsn" jsonb,
	"auto_reply_until" text,
	"unsubscribe_detected" boolean DEFAULT false NOT NULL,
	"triage" jsonb,
	"triage_status" text DEFAULT 'pending' NOT NULL,
	"corrected_class" text,
	"corrected_by" uuid,
	"corrected_at" timestamp with time zone,
	"status" text DEFAULT 'new' NOT NULL,
	"assigned_to" uuid,
	"snoozed_until" timestamp with time zone,
	"raw_storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_sync_state" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"cursor" jsonb,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"lag_seconds" integer,
	"ingested" integer DEFAULT 0 NOT NULL,
	"ignored" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "unread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "latest_triage_class" text;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_outbound_message_id_outbound_messages_id_fk" FOREIGN KEY ("outbound_message_id") REFERENCES "public"."outbound_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sync_state" ADD CONSTRAINT "mailbox_sync_state_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_sync_state" ADD CONSTRAINT "mailbox_sync_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_inbound_messages__mailbox_provider" ON "inbound_messages" USING btree ("mailbox_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "ix_inbound_messages__org_thread" ON "inbound_messages" USING btree ("organization_id","thread_id","received_at");--> statement-breakpoint
CREATE INDEX "ix_inbound_messages__org_status" ON "inbound_messages" USING btree ("organization_id","status","received_at");--> statement-breakpoint
CREATE INDEX "ix_inbound_messages__from" ON "inbound_messages" USING btree ("organization_id","from_email");--> statement-breakpoint
CREATE TRIGGER inbound_messages_set_updated_at BEFORE UPDATE ON "inbound_messages" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER mailbox_sync_state_set_updated_at BEFORE UPDATE ON "mailbox_sync_state" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

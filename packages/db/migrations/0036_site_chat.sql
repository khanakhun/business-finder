CREATE TABLE "site_change_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid,
	"site_id" uuid NOT NULL,
	"base_version_id" uuid NOT NULL,
	"operations" jsonb NOT NULL,
	"summary" text NOT NULL,
	"diff" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"facts_to_assert" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"status_reason" text,
	"applied_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"context" jsonb NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_chat_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_thread_id_site_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."site_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_message_id_site_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."site_chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_base_version_id_site_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."site_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_change_proposals" ADD CONSTRAINT "site_change_proposals_applied_version_id_site_versions_id_fk" FOREIGN KEY ("applied_version_id") REFERENCES "public"."site_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_chat_messages" ADD CONSTRAINT "site_chat_messages_thread_id_site_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."site_chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_chat_threads" ADD CONSTRAINT "site_chat_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_chat_threads" ADD CONSTRAINT "site_chat_threads_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_chat_threads" ADD CONSTRAINT "site_chat_threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_change_proposals_thread_idx" ON "site_change_proposals" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "site_change_proposals_site_idx" ON "site_change_proposals" USING btree ("organization_id","site_id","status");--> statement-breakpoint
CREATE INDEX "site_chat_messages_thread_idx" ON "site_chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "site_chat_threads_site_idx" ON "site_chat_threads" USING btree ("organization_id","site_id","updated_at");
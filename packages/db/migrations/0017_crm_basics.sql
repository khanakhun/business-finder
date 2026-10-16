CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_event_id" uuid
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"author_id" uuid,
	"body_markdown" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_notes__body" CHECK (length("notes"."body_markdown") BETWEEN 1 AND 20000)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"assignee_id" uuid,
	"created_by" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tasks__type" CHECK ("tasks"."type" IN ('call', 'email', 'visit', 'follow_up', 'other')),
	CONSTRAINT "ck_tasks__status" CHECK ("tasks"."status" IN ('open', 'done', 'cancelled')),
	CONSTRAINT "ck_tasks__title" CHECK (length("tasks"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "disqualified_reason" text;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "lost_reason" text;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "do_not_contact_reason" text;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "notes_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "open_tasks_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "org_businesses" ADD COLUMN "next_task_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activities__organization_id_business_id_occurred_at" ON "activities" USING btree ("organization_id","business_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_activities__source_event_id_organization_id" ON "activities" USING btree ("source_event_id","organization_id");--> statement-breakpoint
CREATE INDEX "idx_notes__organization_id_business_id" ON "notes" USING btree ("organization_id","business_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_tasks__organization_id_assignee_id_status_due_at" ON "tasks" USING btree ("organization_id","assignee_id","status","due_at");--> statement-breakpoint
CREATE INDEX "idx_tasks__organization_id_business_id" ON "tasks" USING btree ("organization_id","business_id");--> statement-breakpoint
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON "notes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON "tasks" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

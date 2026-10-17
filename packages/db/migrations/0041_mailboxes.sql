CREATE TABLE "mailbox_daily_usage" (
	"mailbox_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"bounced" integer DEFAULT 0 NOT NULL,
	"complaints" integer DEFAULT 0 NOT NULL,
	"replies" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pk_mailbox_daily_usage" PRIMARY KEY("mailbox_id","day")
);
--> statement-breakpoint
CREATE TABLE "mailbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"provider" text NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_reason" text,
	"daily_cap" integer DEFAULT 50 NOT NULL,
	"ramp" jsonb NOT NULL,
	"window" jsonb NOT NULL,
	"min_interval_sec" integer DEFAULT 90 NOT NULL,
	"locales" text[] DEFAULT ARRAY['en']::text[] NOT NULL,
	"signature_md" text DEFAULT '' NOT NULL,
	"reply_to" "citext",
	"secret_ref" text,
	"provider_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"health" jsonb NOT NULL,
	"last_error" jsonb,
	"last_selected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_mailboxes__caps" CHECK ("mailboxes"."daily_cap" > 0 AND "mailboxes"."min_interval_sec" >= 30)
);
--> statement-breakpoint
ALTER TABLE "mailbox_daily_usage" ADD CONSTRAINT "mailbox_daily_usage_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_events" ADD CONSTRAINT "mailbox_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_events" ADD CONSTRAINT "mailbox_events_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_events" ADD CONSTRAINT "mailbox_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_mailbox_events__mailbox_created" ON "mailbox_events" USING btree ("mailbox_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mailboxes__org_email" ON "mailboxes" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "ix_mailboxes__org_status" ON "mailboxes" USING btree ("organization_id","status");--> statement-breakpoint
CREATE TRIGGER trg_mailboxes__updated_at BEFORE UPDATE ON "mailboxes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

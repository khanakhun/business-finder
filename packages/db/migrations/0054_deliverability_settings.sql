CREATE TABLE "deliverability_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"kill_reason" text,
	"kill_by" uuid,
	"kill_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliverability_settings" ADD CONSTRAINT "deliverability_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverability_settings" ADD CONSTRAINT "deliverability_settings_kill_by_users_id_fk" FOREIGN KEY ("kill_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
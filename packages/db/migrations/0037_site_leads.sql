CREATE TABLE "site_leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"publication_id" uuid,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"name" text,
	"email" "citext",
	"phone" text,
	"whatsapp" text,
	"message" text,
	"preferred_channel" text,
	"preferred_time" text,
	"locale" text NOT NULL,
	"consent" jsonb NOT NULL,
	"attribution" jsonb NOT NULL,
	"spam" jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"handled_by" uuid,
	"submission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_publication_id_site_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."site_publications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_leads_submission_key" ON "site_leads" USING btree ("site_id","submission_id");--> statement-breakpoint
CREATE INDEX "site_leads_inbox_idx" ON "site_leads" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "site_leads_business_idx" ON "site_leads" USING btree ("organization_id","business_id");
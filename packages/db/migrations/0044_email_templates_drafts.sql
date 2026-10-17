CREATE TABLE "email_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"mailbox_id" uuid,
	"template_id" uuid,
	"template_version" integer,
	"purpose" text NOT NULL,
	"offer" text NOT NULL,
	"locale" text NOT NULL,
	"subject" text NOT NULL,
	"subject_variants" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"body_md" text NOT NULL,
	"facts_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" text NOT NULL,
	"ai_meta" jsonb,
	"site_id" uuid,
	"compliance_preview" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"offer" text NOT NULL,
	"locale" text NOT NULL,
	"version" integer NOT NULL,
	"subject_variants" text[] NOT NULL,
	"body_md" text NOT NULL,
	"variables" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"lint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_email_templates__owner_key_locale_version" UNIQUE NULLS NOT DISTINCT("organization_id","key","locale","version")
);
--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_contact_id_business_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."business_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_template_id_email_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_drafts" ADD CONSTRAINT "email_drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_email_drafts__org_business" ON "email_drafts" USING btree ("organization_id","business_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_email_templates__org_key" ON "email_templates" USING btree ("organization_id","key");--> statement-breakpoint
CREATE TRIGGER email_drafts_set_updated_at BEFORE UPDATE ON "email_drafts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A template version is immutable (BF-051): only its status may change (archive).
CREATE TRIGGER email_templates_immutable BEFORE UPDATE ON "email_templates" FOR EACH ROW WHEN (OLD.body_md IS DISTINCT FROM NEW.body_md OR OLD.subject_variants IS DISTINCT FROM NEW.subject_variants OR OLD.version IS DISTINCT FROM NEW.version) EXECUTE FUNCTION bf_append_only();

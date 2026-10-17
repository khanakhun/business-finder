CREATE TABLE "deliverability_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"provider" text NOT NULL,
	"outcome" text NOT NULL,
	"checks" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_readiness_overrides" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliverability_domains" ADD CONSTRAINT "deliverability_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_readiness_overrides" ADD CONSTRAINT "mailbox_readiness_overrides_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_readiness_overrides" ADD CONSTRAINT "mailbox_readiness_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_readiness_overrides" ADD CONSTRAINT "mailbox_readiness_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deliverability_domains__org_domain" ON "deliverability_domains" USING btree ("organization_id","domain");
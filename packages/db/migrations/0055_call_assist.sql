CREATE TABLE "call_scripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"offer" text NOT NULL,
	"locale" text NOT NULL,
	"facts_hash" text NOT NULL,
	"script" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD COLUMN "duration_sec" integer;--> statement-breakpoint
ALTER TABLE "manual_contact_logs" ADD COLUMN "callback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_scripts" ADD CONSTRAINT "call_scripts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_call_scripts__key" ON "call_scripts" USING btree ("organization_id","business_id","offer","locale","facts_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_manual_contact_logs__org_idempotency" ON "manual_contact_logs" USING btree ("organization_id","idempotency_key");
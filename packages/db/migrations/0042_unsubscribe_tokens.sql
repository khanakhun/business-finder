CREATE TABLE "unsubscribe_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"contact_id" uuid,
	"email_sealed" text NOT NULL,
	"email_hash" text NOT NULL,
	"business_id" uuid,
	"outbound_message_id" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unsubscribe_tokens" ADD CONSTRAINT "unsubscribe_tokens_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_unsubscribe_tokens__hash" ON "unsubscribe_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_unsubscribe_tokens__org_email" ON "unsubscribe_tokens" USING btree ("organization_id","email_hash");--> statement-breakpoint
CREATE INDEX "ix_unsubscribe_tokens__expires" ON "unsubscribe_tokens" USING btree ("expires_at");
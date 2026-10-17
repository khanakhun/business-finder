CREATE TABLE "business_recipient_types" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"recipient_type" text NOT NULL,
	"legal_form_code" text,
	"registry_id" text,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_recipient_types" ADD CONSTRAINT "business_recipient_types_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;
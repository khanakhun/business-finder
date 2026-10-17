CREATE TABLE "compliance_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"stage" text NOT NULL,
	"decision" text NOT NULL,
	"jurisdictions" text[] NOT NULL,
	"reasons" jsonb NOT NULL,
	"required_elements" jsonb NOT NULL,
	"alternatives" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"policy_version_ids" uuid[] NOT NULL,
	"lawful_basis_id" uuid,
	"outbound_message_id" uuid,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compliance_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"jurisdiction" text NOT NULL,
	"channel" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"rules" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"note" text,
	"needs_legal_review" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_policies_version_key" UNIQUE NULLS NOT DISTINCT("organization_id","jurisdiction","channel","kind","version")
);
--> statement-breakpoint
CREATE TABLE "compliance_policy_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"reviewer_name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"auto_send_enabled" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lawful_basis_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"purpose" text NOT NULL,
	"data_categories" text NOT NULL,
	"necessity" text NOT NULL,
	"balancing_test" text NOT NULL,
	"safeguards" text NOT NULL,
	"retention" text NOT NULL,
	"document_md" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_relevance" (
	"id" uuid PRIMARY KEY NOT NULL,
	"offer" text NOT NULL,
	"taxonomy_prefix" text NOT NULL,
	"relevant" boolean NOT NULL,
	"rationale" jsonb NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"scope" text NOT NULL,
	"value_normalized" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"actor" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions_current" (
	"organization_id" uuid,
	"scope" text NOT NULL,
	"value_normalized" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "suppressions_current_key" UNIQUE NULLS NOT DISTINCT("organization_id","scope","value_normalized")
);
--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_decisions" ADD CONSTRAINT "compliance_decisions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policy_reviews" ADD CONSTRAINT "compliance_policy_reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policy_reviews" ADD CONSTRAINT "compliance_policy_reviews_policy_id_compliance_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."compliance_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policy_reviews" ADD CONSTRAINT "compliance_policy_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lawful_basis_records" ADD CONSTRAINT "lawful_basis_records_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppression_entries" ADD CONSTRAINT "suppression_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions_current" ADD CONSTRAINT "suppressions_current_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressions_current" ADD CONSTRAINT "suppressions_current_entry_id_suppression_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."suppression_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compliance_decisions_business_idx" ON "compliance_decisions" USING btree ("organization_id","business_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "compliance_decisions_message_idx" ON "compliance_decisions" USING btree ("outbound_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_policy_reviews_key" ON "compliance_policy_reviews" USING btree ("organization_id","policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_relevance_key" ON "offer_relevance" USING btree ("offer","taxonomy_prefix");--> statement-breakpoint
CREATE INDEX "suppression_entries_key_idx" ON "suppression_entries" USING btree ("organization_id","scope","value_normalized");--> statement-breakpoint
-- BF-049: the decision and suppression logs are append-only, and policy versions immutable. A DELETE passes only when it
-- cascades from a parent row (a workspace or business deleted) or under the retention job's `bf.retention = on`.
CREATE OR REPLACE FUNCTION bf_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (pg_trigger_depth() > 1 OR current_setting('bf.retention', true) = 'on') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER compliance_decisions_append_only BEFORE UPDATE OR DELETE ON "compliance_decisions"
  FOR EACH ROW EXECUTE FUNCTION bf_append_only();
--> statement-breakpoint
CREATE TRIGGER suppression_entries_append_only BEFORE UPDATE OR DELETE ON "suppression_entries"
  FOR EACH ROW EXECUTE FUNCTION bf_append_only();
--> statement-breakpoint
CREATE TRIGGER compliance_policies_immutable BEFORE UPDATE ON "compliance_policies"
  FOR EACH ROW EXECUTE FUNCTION bf_append_only();

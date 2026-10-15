CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"ip" "inet",
	"user_agent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_logs_actor_type_check" CHECK ("audit_logs"."actor_type" IN ('user', 'api_key', 'system'))
);
--> statement-breakpoint
CREATE TABLE "org_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"agency_name" text,
	"legal_name" text,
	"postal_address" jsonb,
	"website_url" text,
	"logo_asset_key" text,
	"logo_content_type" text,
	"primary_locale" text DEFAULT 'en' NOT NULL,
	"locales" text[] DEFAULT ARRAY['en']::text[] NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"sender_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"dek_iv" "bytea" NOT NULL,
	"dek_tag" "bytea" NOT NULL,
	"key_version" integer NOT NULL,
	"last4" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "secrets_key_version_check" CHECK ("secrets"."key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_organization_id_occurred_at_idx" ON "audit_logs" USING btree ("organization_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_organization_id_name_key" ON "secrets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "secrets_key_version_idx" ON "secrets" USING btree ("key_version");--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER org_settings_set_updated_at BEFORE UPDATE ON "org_settings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER secrets_set_updated_at BEFORE UPDATE ON "secrets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- The audit log is append-only at the database level (BF-011): even the application role cannot rewrite history.
-- Retention (BF-055) will purge through a dedicated, audited maintenance path.
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% refused)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
--> statement-breakpoint
-- Fire even under session_replication_role = replica. The runtime role should also hold only SELECT/INSERT here and
-- not own the table (so it cannot disable the triggers); separate migration/runtime roles come with BF-060.
ALTER TABLE "audit_logs" ENABLE ALWAYS TRIGGER audit_logs_no_update_delete;
--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ALWAYS TRIGGER audit_logs_no_truncate;

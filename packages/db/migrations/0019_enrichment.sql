CREATE TABLE "enrichment_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"triggered_by_org_id" uuid NOT NULL,
	"requested_by" uuid,
	"trigger" text NOT NULL,
	"requested_steps" text[] NOT NULL,
	"force" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"estimated_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"changed_fields" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"idempotency_key" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_enrichment_runs__status" CHECK ("enrichment_runs"."status" IN ('queued', 'running', 'completed', 'partially_completed', 'failed', 'cancelled')),
	CONSTRAINT "ck_enrichment_runs__trigger" CHECK ("enrichment_runs"."trigger" IN ('discovery', 'manual', 'bulk', 'schedule', 'event')),
	CONSTRAINT "ck_enrichment_runs__money" CHECK ("enrichment_runs"."estimated_usd" >= 0 AND "enrichment_runs"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "enrichment_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"step" text NOT NULL,
	"depends_on" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input_hash" text,
	"output_ref" jsonb,
	"estimated_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"skip_reason" text,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"job_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_enrichment_steps__step" CHECK ("enrichment_steps"."step" IN ('site_intel', 'email_verify', 'reviews', 'psi', 'vision_audit')),
	CONSTRAINT "ck_enrichment_steps__status" CHECK ("enrichment_steps"."status" IN ('queued', 'running', 'done', 'skipped', 'failed')),
	CONSTRAINT "ck_enrichment_steps__skip_reason" CHECK ("enrichment_steps"."skip_reason" IS NULL OR "enrichment_steps"."skip_reason" IN ('fresh', 'no_website', 'not_applicable', 'dependency_failed', 'dependency_skipped', 'budget', 'cancelled', 'not_registered')),
	CONSTRAINT "ck_enrichment_steps__money" CHECK ("enrichment_steps"."estimated_usd" >= 0 AND "enrichment_steps"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "no_solicitation_markers" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"page_url" text NOT NULL,
	"phrases" text[] NOT NULL,
	"snippet" text,
	"snapshot_id" uuid,
	"cleared_at" timestamp with time zone,
	"cleared_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"reachability" text NOT NULL,
	"http_status" integer,
	"social_only" boolean DEFAULT false NOT NULL,
	"tls" jsonb NOT NULL,
	"security" jsonb NOT NULL,
	"languages" jsonb NOT NULL,
	"pages" jsonb NOT NULL,
	"contacts" jsonb NOT NULL,
	"socials" jsonb NOT NULL,
	"booking" jsonb NOT NULL,
	"ordering" jsonb NOT NULL,
	"chat" jsonb NOT NULL,
	"analytics" jsonb NOT NULL,
	"tech" jsonb NOT NULL,
	"freshness" jsonb NOT NULL,
	"mobile" jsonb NOT NULL,
	"performance_hints" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"no_solicitation" jsonb NOT NULL,
	"logo_candidates" jsonb NOT NULL,
	"image_candidates" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"screenshot_desktop_key" text,
	"screenshot_mobile_key" text,
	"content_hash" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN "enrichment" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_triggered_by_org_id_organizations_id_fk" FOREIGN KEY ("triggered_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_steps" ADD CONSTRAINT "enrichment_steps_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_steps" ADD CONSTRAINT "enrichment_steps_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_solicitation_markers" ADD CONSTRAINT "no_solicitation_markers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_solicitation_markers" ADD CONSTRAINT "no_solicitation_markers_snapshot_id_website_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."website_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_solicitation_markers" ADD CONSTRAINT "no_solicitation_markers_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_snapshots" ADD CONSTRAINT "website_snapshots_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_snapshots" ADD CONSTRAINT "website_snapshots_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs__business_id_triggered_by_org_id_created_at" ON "enrichment_runs" USING btree ("business_id","triggered_by_org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs__triggered_by_org_id_created_at" ON "enrichment_runs" USING btree ("triggered_by_org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_enrichment_runs__updated_at_open" ON "enrichment_runs" USING btree ("updated_at") WHERE "enrichment_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrichment_runs__triggered_by_org_id_business_id_open" ON "enrichment_runs" USING btree ("triggered_by_org_id","business_id") WHERE "enrichment_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrichment_runs__triggered_by_org_id_idempotency_key" ON "enrichment_runs" USING btree ("triggered_by_org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_enrichment_steps__run_id_step" ON "enrichment_steps" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX "idx_enrichment_steps__status_heartbeat_at" ON "enrichment_steps" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_enrichment_steps__business_id_step_finished_at" ON "enrichment_steps" USING btree ("business_id","step","finished_at");--> statement-breakpoint
CREATE INDEX "idx_website_snapshots__business_id_fetched_at" ON "website_snapshots" USING btree ("business_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_website_snapshots__run_id" ON "website_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE TRIGGER enrichment_runs_set_updated_at BEFORE UPDATE ON "enrichment_runs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER enrichment_steps_set_updated_at BEFORE UPDATE ON "enrichment_steps" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER no_solicitation_markers_set_updated_at BEFORE UPDATE ON "no_solicitation_markers" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

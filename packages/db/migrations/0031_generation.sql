CREATE TABLE "generation_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_generation_artifacts__kind" CHECK ("generation_artifacts"."kind" IN ('workspace_bundle', 'site_spec', 'screenshot', 'transcript', 'log_bundle'))
);
--> statement-breakpoint
CREATE TABLE "generation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_no" smallint NOT NULL,
	"engine" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"sandbox_ref" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0}'::jsonb NOT NULL,
	"spec_ref" text,
	"exit_reason" text,
	"error" jsonb,
	CONSTRAINT "ck_generation_attempts__status" CHECK ("generation_attempts"."status" IN ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ck_generation_attempts__mode" CHECK ("generation_attempts"."mode" IN ('create', 'repair'))
);
--> statement-breakpoint
CREATE TABLE "generation_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"settings" jsonb NOT NULL,
	"max_parallel" smallint,
	"budget_usd" double precision,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_generation_batches__status" CHECK ("generation_batches"."status" IN ('queued', 'running', 'completed', 'completed_with_issues', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "generation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"site_id" uuid,
	"position" smallint NOT NULL,
	"priority" smallint NOT NULL,
	"engine_requested" text NOT NULL,
	"engine_current" text NOT NULL,
	"engine_selection_reason" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"engine_attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts_per_engine" smallint NOT NULL,
	"failover_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_usd" double precision NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0}'::jsonb NOT NULL,
	"result_version_id" uuid,
	"published_url" text,
	"quality_score" double precision,
	"error_code" text,
	"error_message" text,
	"cancel_requested_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_generation_jobs__status" CHECK ("generation_jobs"."status" IN ('queued', 'preparing', 'running', 'validating', 'repairing', 'succeeded', 'needs_review', 'failed', 'cancelled')),
	CONSTRAINT "ck_generation_jobs__engine" CHECK ("generation_jobs"."engine_current" IN ('blocks', 'claude-agent-sdk', 'claude-code', 'codex', 'fake')),
	CONSTRAINT "ck_generation_jobs__priority" CHECK ("generation_jobs"."priority" BETWEEN 1 AND 10)
);
--> statement-breakpoint
ALTER TABLE "generation_artifacts" ADD CONSTRAINT "generation_artifacts_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_artifacts" ADD CONSTRAINT "generation_artifacts_attempt_id_generation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."generation_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_events" ADD CONSTRAINT "generation_events_job_id_generation_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_events" ADD CONSTRAINT "generation_events_attempt_id_generation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."generation_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_batch_id_generation_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."generation_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_result_version_id_site_versions_id_fk" FOREIGN KEY ("result_version_id") REFERENCES "public"."site_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_generation_artifacts__job_id" ON "generation_artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_artifacts__storage_key" ON "generation_artifacts" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_attempts__job_id_attempt_no" ON "generation_attempts" USING btree ("job_id","attempt_no");--> statement-breakpoint
CREATE INDEX "idx_generation_attempts__heartbeat" ON "generation_attempts" USING btree ("heartbeat_at") WHERE "generation_attempts"."status" = 'running';--> statement-breakpoint
CREATE INDEX "idx_generation_batches__organization_id_created_at" ON "generation_batches" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_batches__organization_id_idempotency_key" ON "generation_batches" USING btree ("organization_id","idempotency_key") WHERE "generation_batches"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_generation_events__job_id_seq" ON "generation_events" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "idx_generation_events__created_at" ON "generation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_generation_jobs__organization_id_batch_id" ON "generation_jobs" USING btree ("organization_id","batch_id");--> statement-breakpoint
CREATE INDEX "idx_generation_jobs__status" ON "generation_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_generation_jobs__batch_id_dispatch" ON "generation_jobs" USING btree ("batch_id","priority","position");--> statement-breakpoint
CREATE TRIGGER generation_jobs_set_updated_at BEFORE UPDATE ON "generation_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

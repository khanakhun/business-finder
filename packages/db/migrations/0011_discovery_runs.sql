-- Drizzle Kit quotes parameterized custom types; unquoted by hand (see 0006).
CREATE TABLE "discovery_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_by" uuid,
	"intent" jsonb NOT NULL,
	"area_id" uuid,
	"area_geometry" geography(MultiPolygon,4326) NOT NULL,
	"providers" text[] NOT NULL,
	"options" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"budget_usd" numeric(12, 6) NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"budget_exhausted" boolean DEFAULT false NOT NULL,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"tasks_failed" integer DEFAULT 0 NOT NULL,
	"tasks_skipped" integer DEFAULT 0 NOT NULL,
	"records_fetched" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"unchanged_count" integer DEFAULT 0 NOT NULL,
	"possible_duplicates" integer DEFAULT 0 NOT NULL,
	"failed_records" integer DEFAULT 0 NOT NULL,
	"ingests_pending" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"error" text,
	"started_at" timestamp with time zone,
	"planned_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_discovery_runs__status" CHECK ("discovery_runs"."status" IN ('queued', 'running', 'completed', 'partially_completed', 'failed', 'cancelled')),
	CONSTRAINT "ck_discovery_runs__reason" CHECK ("discovery_runs"."reason" IS NULL OR "discovery_runs"."reason" IN ('budget', 'monthly_budget', 'tasks_failed', 'cancelled', 'no_providers', 'error')),
	CONSTRAINT "ck_discovery_runs__money" CHECK ("discovery_runs"."budget_usd" >= 0 AND "discovery_runs"."cost_usd" >= 0 AND "discovery_runs"."reserved_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discovery_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"provider" text NOT NULL,
	"category_id" uuid,
	"query" jsonb NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"records" integer DEFAULT 0 NOT NULL,
	"saturated" boolean DEFAULT false NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"pending_records" jsonb,
	"ingested_at" timestamp with time zone,
	"not_before" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_discovery_tasks__status" CHECK ("discovery_tasks"."status" IN ('queued', 'running', 'done', 'failed', 'skipped')),
	CONSTRAINT "ck_discovery_tasks__provider" CHECK ("discovery_tasks"."provider" IN ('google_places', 'overture', 'foursquare', 'osm', 'gmaps_scraper', 'fake'))
);
--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD CONSTRAINT "discovery_runs_area_id_geo_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."geo_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_tasks" ADD CONSTRAINT "discovery_tasks_run_id_discovery_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_tasks" ADD CONSTRAINT "discovery_tasks_parent_task_id_discovery_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."discovery_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_discovery_runs__organization_id_created_at" ON "discovery_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_discovery_runs__status" ON "discovery_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_discovery_runs__organization_id_idempotency_key" ON "discovery_runs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_discovery_tasks__run_id_status" ON "discovery_tasks" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_discovery_tasks__run_id_dedupe_key" ON "discovery_tasks" USING btree ("run_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_discovery_tasks__status_heartbeat_at" ON "discovery_tasks" USING btree ("status","heartbeat_at");--> statement-breakpoint
-- Keep updated_at current for writes that bypass the app (repo convention, migration 0000).
CREATE TRIGGER discovery_runs_set_updated_at BEFORE UPDATE ON "discovery_runs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER discovery_tasks_set_updated_at BEFORE UPDATE ON "discovery_tasks" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

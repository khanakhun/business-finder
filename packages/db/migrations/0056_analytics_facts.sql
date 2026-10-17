CREATE TABLE "analytics_facts" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_type" text NOT NULL,
	"source_key" text NOT NULL,
	"business_id" uuid,
	"site_id" uuid,
	"job_id" uuid,
	"message_id" uuid,
	"enrollment_id" uuid,
	"lead_id" uuid,
	"category_path" "ltree",
	"area_id" uuid,
	"country" text,
	"offer" text,
	"score_tier" text,
	"score_value" smallint,
	"profile_version" integer,
	"engine" text,
	"template_id" uuid,
	"template_version" integer,
	"variant_id" text,
	"mailbox_id" uuid,
	"locale" text,
	"creator_id" uuid,
	"outcome" text,
	"dims" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(14, 6),
	"duration_ms" integer,
	"quality_score" double precision,
	"count" integer DEFAULT 1 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analytics_facts_pkey" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "analytics_watermarks" (
	"source" text PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_analytics_facts__source" ON "analytics_facts" USING btree ("organization_id","source_key","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_analytics_facts__org_type_time" ON "analytics_facts" USING btree ("organization_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_analytics_facts__org_business" ON "analytics_facts" USING btree ("organization_id","business_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_analytics_facts__category" ON "analytics_facts" USING gist ("category_path");--> statement-breakpoint
-- BF-058: monthly partitions (Drizzle does not model partitioning). `analytics_ensure_partitions` creates the months
-- around a date (the refresh job keeps the next ones ahead); the default partition takes anything outside them.
CREATE OR REPLACE FUNCTION analytics_ensure_partitions(around timestamptz, months_before int, months_after int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  first_month date := date_trunc('month', around AT TIME ZONE 'UTC')::date - make_interval(months => months_before);
  m date;
  name text;
BEGIN
  FOR i IN 0 .. (months_before + months_after) LOOP
    m := (first_month + make_interval(months => i))::date;
    name := 'analytics_facts_' || to_char(m, 'YYYY_MM');
    IF to_regclass(name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF analytics_facts FOR VALUES FROM (%L) TO (%L)',
        name,
        (m::timestamp AT TIME ZONE 'UTC'),
        ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC')
      );
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint
SELECT analytics_ensure_partitions(now(), 36, 3);--> statement-breakpoint
CREATE TABLE "analytics_facts_default" PARTITION OF "analytics_facts" DEFAULT;

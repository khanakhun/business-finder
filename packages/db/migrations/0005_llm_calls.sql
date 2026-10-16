CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"task" text NOT NULL,
	"prompt_version" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_status_check" CHECK ("llm_calls"."status" IN ('ok', 'cached', 'error'))
);
--> statement-breakpoint
CREATE INDEX "llm_calls_organization_id_created_at_idx" ON "llm_calls" USING btree ("organization_id","created_at");
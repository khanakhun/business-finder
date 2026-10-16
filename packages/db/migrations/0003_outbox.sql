CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"version" integer NOT NULL,
	"organization_id" uuid,
	"payload" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("available_at") WHERE "outbox_events"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_events_occurred_at_idx" ON "outbox_events" USING btree ("occurred_at");
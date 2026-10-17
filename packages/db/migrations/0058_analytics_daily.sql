CREATE TABLE "analytics_daily" (
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"score_tier" text DEFAULT '' NOT NULL,
	"engine" text DEFAULT '' NOT NULL,
	"offer" text DEFAULT '' NOT NULL,
	"facts" integer NOT NULL,
	"units" bigint NOT NULL,
	"cost_usd" numeric(16, 6) DEFAULT 0 NOT NULL,
	"duration_ms_sum" bigint DEFAULT 0 NOT NULL,
	"quality_sum" double precision DEFAULT 0 NOT NULL,
	"quality_n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_daily_pkey" PRIMARY KEY("organization_id","day","event_type","outcome","category","score_tier","engine","offer")
);

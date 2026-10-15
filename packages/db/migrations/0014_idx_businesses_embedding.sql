-- bf:no-transaction
-- Standalone: CREATE INDEX CONCURRENTLY cannot run in a transaction (packages/db README, BF-022).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_businesses__embedding" ON "businesses" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64) WHERE "businesses"."embedding" IS NOT NULL;

-- bf:no-transaction
-- Standalone: CREATE INDEX CONCURRENTLY cannot run in a transaction (packages/db README, BF-022).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_businesses__search_tsv" ON "businesses" USING gin ("search_tsv");

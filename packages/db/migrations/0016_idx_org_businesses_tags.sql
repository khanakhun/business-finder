-- bf:no-transaction
-- Standalone: CREATE INDEX CONCURRENTLY cannot run in a transaction (packages/db README, BF-022).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_org_businesses__tags" ON "org_businesses" USING gin ("tags");

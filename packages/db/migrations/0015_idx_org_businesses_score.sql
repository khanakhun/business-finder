-- bf:no-transaction
-- Standalone: CREATE INDEX CONCURRENTLY cannot run in a transaction (packages/db README, BF-022).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_org_businesses__organization_id_score" ON "org_businesses" USING btree ("organization_id","score" DESC NULLS LAST,"business_id" DESC NULLS LAST);

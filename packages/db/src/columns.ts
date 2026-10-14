import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// TODO(BF-004): replace with newId() from @bf/contracts.
const newId = (): string => uuidv7();

/** UUIDv7 primary key. The app supplies the value (time-ordered, generated before insert). */
export const id = () => uuid().primaryKey().$defaultFn(newId);

/** Owning organization of an org-scoped row (coding-standards §5: first column of leading indexes). */
export const orgId = () => uuid('organization_id').notNull();

/**
 * `created_at` / `updated_at`, both `timestamptz`. Keep `updated_at` current with the `set_updated_at()`
 * trigger from migration 0000: `CREATE TRIGGER … BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();`
 */
export const timestamps = () => ({
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

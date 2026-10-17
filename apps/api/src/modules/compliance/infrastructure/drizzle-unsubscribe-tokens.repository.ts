import { type DbClient, getExecutor } from '@bf/db';
import { unsubscribeTokens } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, lt } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { UnsubscribeTokenRepository, UnsubscribeTokenRow } from '../application/ports.ts';

@Injectable()
export class DrizzleUnsubscribeTokenRepository implements UnsubscribeTokenRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async insert(row: Parameters<UnsubscribeTokenRepository['insert']>[0]) {
    const [stored] = await getExecutor(this.db)
      .insert(unsubscribeTokens)
      .values(row)
      .returning({ id: unsubscribeTokens.id });
    if (!stored) throw new Error('unsubscribe token not stored');
    return stored.id;
  }

  async findByHash(tokenHash: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(unsubscribeTokens)
      .where(eq(unsubscribeTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row) return undefined;
    const { tokenHash: _hash, ...rest } = row;
    return rest as UnsubscribeTokenRow;
  }

  async markUsed(id: string, at: Date) {
    await getExecutor(this.db)
      .update(unsubscribeTokens)
      .set({ usedAt: at })
      .where(eq(unsubscribeTokens.id, id));
  }

  async deleteExpired(before: Date, limit: number) {
    const x = getExecutor(this.db);
    const ids = await x
      .select({ id: unsubscribeTokens.id })
      .from(unsubscribeTokens)
      .where(lt(unsubscribeTokens.expiresAt, before))
      .limit(limit);
    if (ids.length === 0) return 0;
    const deleted = await x
      .delete(unsubscribeTokens)
      .where(
        inArray(
          unsubscribeTokens.id,
          ids.map((row) => row.id),
        ),
      )
      .returning({ id: unsubscribeTokens.id });
    return deleted.length;
  }
}

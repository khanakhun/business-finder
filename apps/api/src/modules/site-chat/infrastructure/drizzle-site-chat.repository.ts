import { type DbClient, getExecutor } from '@bf/db';
import { siteChangeProposals, siteChatMessages, siteChatThreads } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, ne } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  SiteChatRepository,
  StoredMessage,
  StoredProposal,
  StoredThread,
} from '../application/ports.ts';

/** Chat threads, messages and proposals (BF-047), always read within the workspace. */
@Injectable()
export class DrizzleSiteChatRepository implements SiteChatRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async insertThread(thread: Omit<StoredThread, 'createdAt' | 'updatedAt'>) {
    const [row] = await this.x.insert(siteChatThreads).values(thread).returning();
    return row as StoredThread;
  }

  async thread(organizationId: string, siteId: string, threadId: string) {
    const [row] = await this.x
      .select()
      .from(siteChatThreads)
      .where(
        and(
          eq(siteChatThreads.organizationId, organizationId),
          eq(siteChatThreads.siteId, siteId),
          eq(siteChatThreads.id, threadId),
        ),
      )
      .limit(1);
    return row as StoredThread | undefined;
  }

  async threads(organizationId: string, siteId: string, limit: number) {
    return (await this.x
      .select()
      .from(siteChatThreads)
      .where(and(eq(siteChatThreads.organizationId, organizationId), eq(siteChatThreads.siteId, siteId)))
      .orderBy(desc(siteChatThreads.updatedAt))
      .limit(limit)) as StoredThread[];
  }

  async touchThread(threadId: string) {
    await this.x
      .update(siteChatThreads)
      .set({ updatedAt: new Date() })
      .where(eq(siteChatThreads.id, threadId));
  }

  async insertMessage(message: Omit<StoredMessage, 'createdAt'>) {
    const [row] = await this.x.insert(siteChatMessages).values(message).returning();
    return row as StoredMessage;
  }

  async messages(threadId: string, limit: number) {
    const rows = await this.x
      .select()
      .from(siteChatMessages)
      .where(eq(siteChatMessages.threadId, threadId))
      .orderBy(desc(siteChatMessages.createdAt))
      .limit(limit);
    return (rows as StoredMessage[]).reverse();
  }

  async setMessageParts(messageId: string, parts: StoredMessage['parts'], costUsd: number) {
    await this.x.update(siteChatMessages).set({ parts, costUsd }).where(eq(siteChatMessages.id, messageId));
  }

  async insertProposal(
    proposal: Omit<
      StoredProposal,
      'createdAt' | 'updatedAt' | 'status' | 'statusReason' | 'appliedVersionId'
    >,
  ) {
    const [row] = await this.x.insert(siteChangeProposals).values(proposal).returning();
    return row as StoredProposal;
  }

  async proposal(organizationId: string, siteId: string, proposalId: string) {
    const [row] = await this.x
      .select()
      .from(siteChangeProposals)
      .where(
        and(
          eq(siteChangeProposals.organizationId, organizationId),
          eq(siteChangeProposals.siteId, siteId),
          eq(siteChangeProposals.id, proposalId),
        ),
      )
      .limit(1);
    return row as StoredProposal | undefined;
  }

  async proposals(threadId: string) {
    return (await this.x
      .select()
      .from(siteChangeProposals)
      .where(eq(siteChangeProposals.threadId, threadId))
      .orderBy(asc(siteChangeProposals.createdAt))) as StoredProposal[];
  }

  async settleProposal(
    proposalId: string,
    change: {
      status: StoredProposal['status'];
      statusReason?: string | null;
      appliedVersionId?: string | null;
    },
  ) {
    const rows = await this.x
      .update(siteChangeProposals)
      .set({
        status: change.status,
        statusReason: change.statusReason ?? null,
        appliedVersionId: change.appliedVersionId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(siteChangeProposals.id, proposalId), eq(siteChangeProposals.status, 'proposed')))
      .returning({ id: siteChangeProposals.id });
    return rows.length > 0;
  }

  async supersedeOpen(threadId: string, exceptId: string, reason: string) {
    await this.x
      .update(siteChangeProposals)
      .set({ status: 'superseded', statusReason: reason, updatedAt: new Date() })
      .where(
        and(
          eq(siteChangeProposals.threadId, threadId),
          eq(siteChangeProposals.status, 'proposed'),
          ne(siteChangeProposals.id, exceptId),
        ),
      );
  }

  async deleteThreadsBefore(before: Date, limit: number) {
    const old = await this.x
      .select({ id: siteChatThreads.id })
      .from(siteChatThreads)
      .where(lt(siteChatThreads.updatedAt, before))
      .limit(limit);
    if (old.length === 0) return 0;
    await this.x.delete(siteChatThreads).where(
      inArray(
        siteChatThreads.id,
        old.map((row) => row.id),
      ),
    );
    return old.length;
  }
}

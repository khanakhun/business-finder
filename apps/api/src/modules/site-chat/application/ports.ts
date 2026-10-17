import type {
  PendingFact,
  ProposalIssue,
  ProposalStatus,
  SiteChatContext,
  SiteChatPart,
} from '@bf/contracts';

// Ports of chat-based site editing (BF-047).

export interface StoredThread {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly createdBy: string | null;
  readonly title: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: 'user' | 'assistant';
  readonly parts: SiteChatPart[];
  readonly context: SiteChatContext;
  readonly costUsd: number;
  readonly createdAt: Date;
}

export interface StoredProposal {
  readonly id: string;
  readonly organizationId: string;
  readonly threadId: string;
  readonly messageId: string | null;
  readonly siteId: string;
  readonly baseVersionId: string;
  readonly operations: Record<string, unknown>[];
  readonly summary: string;
  readonly diff: Record<string, unknown>;
  readonly issues: ProposalIssue[];
  readonly factsToAssert: PendingFact[];
  readonly status: ProposalStatus;
  readonly statusReason: string | null;
  readonly appliedVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SiteChatRepository {
  insertThread(thread: Omit<StoredThread, 'createdAt' | 'updatedAt'>): Promise<StoredThread>;
  thread(organizationId: string, siteId: string, threadId: string): Promise<StoredThread | undefined>;
  threads(organizationId: string, siteId: string, limit: number): Promise<StoredThread[]>;
  touchThread(threadId: string): Promise<void>;
  insertMessage(message: Omit<StoredMessage, 'createdAt'>): Promise<StoredMessage>;
  /** Oldest first, the last `limit`. */
  messages(threadId: string, limit: number): Promise<StoredMessage[]>;
  setMessageParts(messageId: string, parts: SiteChatPart[], costUsd: number): Promise<void>;
  insertProposal(
    proposal: Omit<
      StoredProposal,
      'createdAt' | 'updatedAt' | 'status' | 'statusReason' | 'appliedVersionId'
    >,
  ): Promise<StoredProposal>;
  proposal(organizationId: string, siteId: string, proposalId: string): Promise<StoredProposal | undefined>;
  proposals(threadId: string): Promise<StoredProposal[]>;
  /** Moves a proposal on only from `proposed` (compare-and-set); false when it had already moved. */
  settleProposal(
    proposalId: string,
    change: { status: ProposalStatus; statusReason?: string | null; appliedVersionId?: string | null },
  ): Promise<boolean>;
  /** Older open proposals of the thread are superseded by a new one. */
  supersedeOpen(threadId: string, exceptId: string, reason: string): Promise<void>;
  /** Threads (with their messages and proposals) not updated since `before`: the retention purge. */
  deleteThreadsBefore(before: Date, limit: number): Promise<number>;
}
export const SITE_CHAT_REPOSITORY = Symbol('SiteChatRepository');

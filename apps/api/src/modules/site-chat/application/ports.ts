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

// ── The edit agent (part 2) ─────────────────────────────────────────────────────────────────────────────────────

/** What the agent's action tools do, decided by the application (dry run, policy, storage). */
export interface EditAgentActions {
  /** A dry run of the operations: a proposal id when valid, else the problems to fix. */
  propose(
    operations: unknown[],
    summary: string,
  ): Promise<
    { readonly ok: true; readonly proposalId: string } | { readonly ok: false; readonly problems: string[] }
  >;
  /** A fact the user stated, to confirm with the next proposal. */
  proposeFact(fact: {
    kind: string;
    value: unknown;
    locale?: string | undefined;
    note?: string | undefined;
  }): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly problem: string };
  clarify(question: string, options: string[]): void;
  refuse(reason: string, alternatives: string[]): void;
}

export type EditAgentEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: string; readonly summary: string };

export interface EditAgentRequest {
  readonly organizationId: string;
  readonly uiLanguage: 'en' | 'fr';
  readonly selection: string;
  readonly message: string;
  readonly history: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  /** The site as of the base version (read tools look into it). */
  readonly spec: import('@bf/site-schema').SiteSpec;
  /** The display facts the site may state (read tools look into them). */
  readonly facts: import('@bf/site-schema').FactRegistry;
  readonly brief: string;
}

export interface EditAgent {
  run(
    request: EditAgentRequest,
    actions: EditAgentActions,
    emit: (event: EditAgentEvent) => void,
  ): Promise<{ readonly text: string; readonly costUsd: number }>;
}
export const EDIT_AGENT = Symbol('EditAgent');

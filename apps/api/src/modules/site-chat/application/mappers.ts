import type { SiteChangeProposal, SiteChatMessage, SiteChatThread } from '@bf/contracts';
import type { StoredMessage, StoredProposal, StoredThread } from './ports.ts';

export const toThread = (thread: StoredThread): SiteChatThread => ({
  id: thread.id,
  siteId: thread.siteId as SiteChatThread['siteId'],
  title: thread.title,
  createdBy: thread.createdBy,
  createdAt: thread.createdAt.toISOString(),
  updatedAt: thread.updatedAt.toISOString(),
});

export const toMessage = (message: StoredMessage): SiteChatMessage => ({
  id: message.id,
  threadId: message.threadId,
  role: message.role,
  parts: message.parts,
  context: message.context,
  costUsd: message.costUsd,
  createdAt: message.createdAt.toISOString(),
});

export const toProposal = (proposal: StoredProposal): SiteChangeProposal => ({
  id: proposal.id,
  threadId: proposal.threadId,
  messageId: proposal.messageId,
  siteId: proposal.siteId as SiteChangeProposal['siteId'],
  baseVersionId: proposal.baseVersionId,
  operations: proposal.operations,
  summary: proposal.summary,
  diff: proposal.diff,
  issues: proposal.issues,
  factsToAssert: proposal.factsToAssert,
  status: proposal.status,
  statusReason: proposal.statusReason,
  appliedVersionId: proposal.appliedVersionId,
  createdAt: proposal.createdAt.toISOString(),
  updatedAt: proposal.updatedAt.toISOString(),
});

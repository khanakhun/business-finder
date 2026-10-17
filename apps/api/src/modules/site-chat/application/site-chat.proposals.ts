import {
  type ApplyProposalResult,
  ConflictError,
  NotFoundError,
  type SiteChangeProposal,
  type SiteChatThreadDetail,
  type SiteChatThreadList,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { FactRegistryService } from '../../generation/index.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { SiteCommands, SiteQueries } from '../../sites/index.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { isOpen } from '../domain/proposal-policy.ts';
import { toMessage, toProposal, toThread } from './mappers.ts';
import { SITE_CHAT_REPOSITORY, type SiteChatRepository } from './ports.ts';

// Proposals of the edit agent, decided by a person (BF-047): apply makes exactly one new version (author
// `chat_edit`, never published) after storing the facts the person confirmed; a proposal made on an older version is
// re-applied to the current one, and superseded — with why — when it no longer applies. Discard changes nothing.

export interface ChatActor {
  readonly organizationId: string;
  readonly userId: string;
}

const MESSAGES_SHOWN = 200;

@Injectable()
export class SiteChatProposals {
  constructor(
    @Inject(SITE_CHAT_REPOSITORY) private readonly repository: SiteChatRepository,
    private readonly sites: SiteQueries,
    private readonly siteCommands: SiteCommands,
    private readonly facts: FactRegistryService,
    private readonly audit: AuditLogger,
  ) {}

  async threads(actor: ChatActor, siteId: string): Promise<SiteChatThreadList> {
    await this.sites.get(actor.organizationId, siteId);
    return { items: (await this.repository.threads(actor.organizationId, siteId, 50)).map(toThread) };
  }

  async thread(actor: ChatActor, siteId: string, threadId: string): Promise<SiteChatThreadDetail> {
    const thread = await this.repository.thread(actor.organizationId, siteId, threadId);
    if (!thread) throw new NotFoundError('SiteChatThread', threadId);
    const [messages, proposals] = await Promise.all([
      this.repository.messages(thread.id, MESSAGES_SHOWN),
      this.repository.proposals(thread.id),
    ]);
    return { ...toThread(thread), messages: messages.map(toMessage), proposals: proposals.map(toProposal) };
  }

  @Transactional()
  async apply(
    actor: ChatActor,
    siteId: string,
    proposalId: string,
    confirmFacts: readonly string[],
  ): Promise<ApplyProposalResult> {
    const proposal = await this.open(actor, siteId, proposalId);
    const site = await this.sites.get(actor.organizationId, siteId);
    const current = site.currentVersion;
    if (!current)
      throw new ConflictError('The site has no version to edit.', { details: { reason: 'SITE_NO_VERSION' } });
    const rebased = current.id !== proposal.baseVersionId;

    // The facts the person confirmed first (the new version may state them); the others are dropped.
    const confirmed = new Set(confirmFacts);
    for (const fact of proposal.factsToAssert) {
      if (!confirmed.has(fact.id)) continue;
      await this.facts.create(actor, site.businessId, {
        kind: fact.kind,
        value: fact.value,
        ...(fact.locale ? { locale: fact.locale } : {}),
        note: (fact.note ?? 'Stated in the site chat').slice(0, 500),
      });
    }

    let version: { id: string; versionNumber: number };
    try {
      version = await this.siteCommands.applyOperations(
        actor,
        siteId,
        {
          operations: proposal.operations,
          baseVersionId: current.id,
          changeSummary: proposal.summary.slice(0, 300),
        },
        { type: 'chat_edit', id: actor.userId },
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        // Made on an older version that no longer takes these operations: superseded; on its own base: failed.
        const reason = rebased
          ? 'The site changed since this proposal was made, and it no longer applies. Ask again.'
          : `The proposal no longer validates: ${error.message}`;
        await this.repository.settleProposal(proposal.id, {
          status: rebased ? 'superseded' : 'failed',
          statusReason: reason.slice(0, 500),
        });
        throw new ConflictError(reason, {
          details: { reason: rebased ? 'PROPOSAL_SUPERSEDED' : 'PROPOSAL_FAILED' },
        });
      }
      throw error;
    }
    if (
      !(await this.repository.settleProposal(proposal.id, {
        status: 'applied',
        appliedVersionId: version.id,
      }))
    )
      throw new ConflictError('This proposal was already decided.', {
        details: { reason: 'PROPOSAL_SETTLED' },
      });
    await this.audit.record({
      action: 'site.chat_proposal_applied',
      entityType: 'site',
      entityId: siteId,
      metadata: { proposalId: proposal.id, versionId: version.id, rebased, factsConfirmed: confirmed.size },
    });
    const applied = await this.repository.proposal(actor.organizationId, siteId, proposal.id);
    return {
      proposal: toProposal(applied ?? proposal),
      versionId: version.id,
      versionNumber: version.versionNumber,
      rebased,
    };
  }

  async discard(actor: ChatActor, siteId: string, proposalId: string): Promise<SiteChangeProposal> {
    const proposal = await this.open(actor, siteId, proposalId);
    if (!(await this.repository.settleProposal(proposal.id, { status: 'discarded' })))
      throw new ConflictError('This proposal was already decided.', {
        details: { reason: 'PROPOSAL_SETTLED' },
      });
    const discarded = await this.repository.proposal(actor.organizationId, siteId, proposal.id);
    return toProposal(discarded ?? proposal);
  }

  private async open(actor: ChatActor, siteId: string, proposalId: string) {
    const proposal = await this.repository.proposal(actor.organizationId, siteId, proposalId);
    if (!proposal) throw new NotFoundError('SiteChangeProposal', proposalId);
    if (!isOpen(proposal.status))
      throw new ConflictError(`This proposal is ${proposal.status}.`, {
        details: { reason: 'PROPOSAL_SETTLED', status: proposal.status },
      });
    return proposal;
  }
}

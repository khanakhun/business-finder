import {
  NotFoundError,
  newId,
  type PendingFact,
  PendingFactSchema,
  type ProposalIssue,
  type SendSiteChatMessageRequest,
  type SiteChangeProposal,
  type SiteChatMessage,
  type SiteChatPart,
} from '@bf/contracts';
import { apply, migrateSpec, OperationError, OperationSchema, type SiteSpec } from '@bf/site-schema';
import { diffSpecs } from '@bf/site-schema/diff';
import { lintCopy, parseFacts, type SitekitConfig, SitekitConfigSchema, validate } from '@bf/sitekit';
import { Inject, Injectable } from '@nestjs/common';
import { FactRegistryService, toSiteFactRegistry } from '../../generation/index.ts';
import { SiteQueries } from '../../sites/index.ts';
import { blockCount } from '../domain/outline.ts';
import { policyRefusal } from '../domain/proposal-policy.ts';
import { toMessage, toProposal } from './mappers.ts';
import {
  EDIT_AGENT,
  type EditAgent,
  type EditAgentActions,
  SITE_CHAT_REPOSITORY,
  type SiteChatRepository,
} from './ports.ts';
import type { ChatActor } from './site-chat.proposals.ts';

// A message to the edit agent (BF-047): stored, answered by the agent (streamed through `emit`), and every proposal
// it makes is dry-run first — the operations applied to the base version, then schema, strict facts and copy lint;
// only problems the change introduces count, and the policy (size, whole-site) applies. A valid proposal is stored for
// a person to apply; nothing is applied here.

export const SITE_CHAT_ASSET_HOSTS = Symbol('SiteChatAssetHosts');

const HISTORY = 10;
const MAX_PROBLEMS = 12;

export type ChatStreamEvent =
  | { readonly type: 'thread'; readonly threadId: string; readonly messageId: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool'; readonly tool: string; readonly summary: string }
  | { readonly type: 'proposal'; readonly proposal: SiteChangeProposal }
  | { readonly type: 'clarification'; readonly question: string; readonly options: string[] }
  | { readonly type: 'refusal'; readonly reason: string; readonly alternatives: string[] }
  | { readonly type: 'done'; readonly message: SiteChatMessage }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

interface Finding {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly path: readonly (string | number)[];
  readonly message: string;
}

const issueKey = (issue: Finding) => `${issue.code}@${issue.path.join('.')}`;

/** Schema, strict facts and copy lint findings of a spec, in one shape. */
function findings(
  spec: SiteSpec,
  input: { config: SitekitConfig; facts: ReturnType<typeof parseFacts> },
): Finding[] {
  return [
    ...validate(spec, input).map((issue) => ({
      code: issue.code,
      severity: issue.severity === 'error' ? ('error' as const) : ('warning' as const),
      path: issue.path,
      message: issue.message,
    })),
    ...lintCopy(spec, input).map((issue) => ({
      code: `copy.${issue.rule}`,
      severity: issue.severity,
      path: issue.path,
      message: issue.message,
    })),
  ];
}

@Injectable()
export class SiteChatMessages {
  constructor(
    @Inject(SITE_CHAT_REPOSITORY) private readonly repository: SiteChatRepository,
    @Inject(EDIT_AGENT) private readonly agent: EditAgent,
    @Inject(SITE_CHAT_ASSET_HOSTS) private readonly assetHosts: readonly string[],
    private readonly sites: SiteQueries,
    private readonly facts: FactRegistryService,
  ) {}

  async send(
    actor: ChatActor,
    siteId: string,
    request: SendSiteChatMessageRequest,
    uiLanguage: 'en' | 'fr',
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const site = await this.sites.get(actor.organizationId, siteId);
    const baseVersionId = request.context?.baseVersionId ?? site.currentVersion?.id;
    if (!baseVersionId) throw new NotFoundError('SiteVersion', 'current');
    const version = await this.sites.version(actor.organizationId, siteId, baseVersionId);
    const spec = migrateSpec(version.spec);
    const registry = parseFacts(
      toSiteFactRegistry((await this.facts.registry(actor, site.businessId)).facts),
    );
    const config: SitekitConfig = SitekitConfigSchema.parse({
      locales: spec.locales,
      defaultLocale: spec.defaultLocale,
      assetHosts: this.assetHosts,
    });

    const thread = request.threadId
      ? await this.repository.thread(actor.organizationId, siteId, request.threadId)
      : await this.repository.insertThread({
          id: newId(),
          organizationId: actor.organizationId,
          siteId,
          createdBy: actor.userId,
          title: request.message.trim().slice(0, 80),
        });
    if (!thread) throw new NotFoundError('SiteChatThread', request.threadId ?? '');
    const history = await this.repository.messages(thread.id, HISTORY);
    const context = { ...(request.context ?? {}), baseVersionId };
    await this.repository.insertMessage({
      id: newId(),
      threadId: thread.id,
      role: 'user',
      parts: [{ type: 'text', text: request.message }],
      context,
      costUsd: 0,
    });
    const reply = await this.repository.insertMessage({
      id: newId(),
      threadId: thread.id,
      role: 'assistant',
      parts: [],
      context,
      costUsd: 0,
    });
    emit({ type: 'thread', threadId: thread.id, messageId: reply.id });

    const parts: SiteChatPart[] = [];
    const pending: PendingFact[] = [];
    const baseIssues = new Set(
      findings(spec, { config, facts: registry })
        .filter((issue) => issue.severity === 'error')
        .map(issueKey),
    );
    const totalBlocks = blockCount(spec);

    const actions: EditAgentActions = {
      propose: async (operations, summary) => {
        const parsed = OperationSchema.safeParse(
          operations.length === 1 ? operations[0] : { op: 'batch', ops: operations },
        );
        if (!parsed.success)
          return {
            ok: false,
            problems: parsed.error.issues
              .slice(0, MAX_PROBLEMS)
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          };
        let after: SiteSpec;
        try {
          after = apply(spec, parsed.data).spec;
        } catch (error) {
          if (!(error instanceof OperationError)) throw error;
          return {
            ok: false,
            problems: [
              error.message,
              ...error.details.map((detail) => `${detail.path.join('.')}: ${detail.message}`),
            ].slice(0, MAX_PROBLEMS),
          };
        }
        const found = findings(after, { config, facts: registry });
        const introduced = found.filter(
          (issue) => issue.severity === 'error' && !baseIssues.has(issueKey(issue)),
        );
        if (introduced.length > 0)
          return {
            ok: false,
            problems: introduced
              .slice(0, MAX_PROBLEMS)
              .map((issue) => `${issue.code} at ${issue.path.join('.')}: ${issue.message}`),
          };
        const diff = diffSpecs(spec, after);
        const refusal = policyRefusal({
          operations: operations.length,
          diff,
          totalBlocks,
          userMessage: request.message,
        });
        if (refusal)
          return {
            ok: false,
            problems: [
              refusal.code === 'TOO_MANY_OPERATIONS'
                ? `At most ${refusal.limit} operations per proposal: make a smaller change.`
                : refusal.code === 'NO_CHANGE'
                  ? 'These operations change nothing.'
                  : `This changes ${refusal.touched} of ${refusal.total} sections; the person did not ask to redo the whole site. Ask them with ask_clarification first.`,
            ],
          };
        const issues: ProposalIssue[] = found
          .filter((issue) => issue.severity === 'warning')
          .slice(0, 50)
          .map((issue) => ({
            severity: 'warning',
            code: issue.code.slice(0, 80),
            message: issue.message.slice(0, 600),
            path: [...issue.path].slice(0, 20),
          }));
        const proposal = await this.repository.insertProposal({
          id: newId(),
          organizationId: actor.organizationId,
          threadId: thread.id,
          messageId: reply.id,
          siteId,
          baseVersionId,
          operations: operations as Record<string, unknown>[],
          summary: summary.trim().slice(0, 1000) || diff.summary,
          diff: diff as unknown as Record<string, unknown>,
          issues,
          factsToAssert: pending.splice(0),
        });
        await this.repository.supersedeOpen(thread.id, proposal.id, 'A newer proposal replaced it.');
        parts.push({ type: 'proposal', proposalId: proposal.id });
        emit({ type: 'proposal', proposal: toProposal(proposal) });
        return { ok: true, proposalId: proposal.id };
      },
      proposeFact: (fact) => {
        if (pending.length >= 10) return { ok: false, problem: 'At most 10 facts per proposal.' };
        const parsed = PendingFactSchema.safeParse({ ...fact, id: `pf_${pending.length + 1}` });
        if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? 'Invalid fact' };
        pending.push(parsed.data);
        return { ok: true, id: parsed.data.id };
      },
      clarify: (question, options) => {
        const part = {
          type: 'clarification' as const,
          question: question.slice(0, 500),
          options: options.slice(0, 6).map((o) => o.slice(0, 120)),
        };
        parts.push(part);
        emit({ type: 'clarification', question: part.question, options: part.options });
      },
      refuse: (reason, alternatives) => {
        const part = {
          type: 'refusal' as const,
          reason: reason.slice(0, 500),
          alternatives: alternatives.slice(0, 4).map((a) => a.slice(0, 200)),
        };
        parts.push(part);
        emit({ type: 'refusal', reason: part.reason, alternatives: part.alternatives });
      },
    };

    const selection = [
      request.context?.pageId ? `page ${request.context.pageId}` : null,
      request.context?.blockId ? `section ${request.context.blockId}` : null,
      request.context?.locale ? `language ${request.context.locale.toUpperCase()}` : null,
      request.context?.viewport ?? null,
    ]
      .filter(Boolean)
      .join(', ');
    let costUsd = 0;
    let text = '';
    try {
      const result = await this.agent.run(
        {
          organizationId: actor.organizationId,
          uiLanguage,
          selection: selection || 'the whole site',
          message: request.message,
          history: history.map((message) => ({
            role: message.role,
            content: message.parts
              .map((part) => (part.type === 'text' ? part.text : part.type === 'refusal' ? part.reason : ''))
              .filter(Boolean)
              .join('\n')
              .slice(0, 2_000),
          })),
          spec,
          facts: registry,
          brief: '',
        },
        actions,
        (event) => {
          if (event.type === 'tool') parts.push({ type: 'tool', tool: event.tool, summary: event.summary });
          emit(event);
        },
      );
      text = result.text;
      costUsd = result.costUsd;
    } catch (error) {
      emit({
        type: 'error',
        code: (error as { code?: string }).code ?? 'AGENT_FAILED',
        message: 'The assistant could not answer. Try again.',
      });
    }
    const finalParts: SiteChatPart[] = [
      ...(text.trim() ? [{ type: 'text' as const, text: text.slice(0, 8000) }] : []),
      ...parts,
    ];
    await this.repository.setMessageParts(reply.id, finalParts, costUsd);
    await this.repository.touchThread(thread.id);
    emit({ type: 'done', message: toMessage({ ...reply, parts: finalParts, costUsd }) });
  }
}

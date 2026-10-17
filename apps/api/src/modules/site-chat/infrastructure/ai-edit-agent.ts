import { type AiGateway, SitesEditAgent } from '@bf/ai';
import { BLOCK_TYPES, type BlockType, blockMarkdown, type SiteSpec } from '@bf/site-schema';
import { Inject, Injectable } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { AI_GATEWAY } from '../../platform/ai/ai.module.ts';
import type { EditAgent, EditAgentActions, EditAgentEvent, EditAgentRequest } from '../application/ports.ts';
import { siteOutline } from '../domain/outline.ts';

// The edit agent on the AI gateway (BF-047): `sites.edit_agent` with read tools over the base version, its facts and
// the block catalog, and action tools that only propose — a dry-run-validated operation set, a fact to confirm, a
// question, a refusal. No publish, network or database tool. At most 8 model steps per message.

const MAX_STEPS = 8;
const MAX_TOOL_OUTPUT = 6_000;

const cut = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}… (cut)` : text;
};

/** One line for the chat's collapsed tool activity. */
function summarize(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'get_site_outline':
      return 'Read the site outline';
    case 'get_block':
      return `Read section ${String(args.blockId ?? '')}`;
    case 'get_facts':
      return args.kind ? `Checked facts (${String(args.kind)})` : 'Checked facts';
    case 'get_catalog':
      return args.blockType ? `Read the catalog (${String(args.blockType)})` : 'Read the catalog';
    case 'list_assets':
      return 'Listed images';
    case 'propose_operations':
      return 'Checked a proposal';
    case 'propose_user_fact':
      return `Noted a fact to confirm (${String(args.kind ?? '')})`;
    case 'ask_clarification':
      return 'Asked a question';
    case 'refuse':
      return 'Declined a request';
    default:
      return tool;
  }
}

export function editTools(spec: SiteSpec, facts: EditAgentRequest['facts'], actions: EditAgentActions) {
  return {
    get_site_outline: tool({
      description:
        'The site: pages, their sections (id, type, variant, short texts per locale), theme and locales.',
      inputSchema: z.object({}),
      execute: async () => siteOutline(spec),
    }),
    get_block: tool({
      description: 'One section in full (all its props), to read before changing it.',
      inputSchema: z.object({ pageId: z.string().max(80), blockId: z.string().max(80) }),
      execute: async ({ pageId, blockId }) => {
        const block = spec.pages.find((page) => page.id === pageId)?.blocks.find((b) => b.id === blockId);
        return block ? cut(block) : `No section ${blockId} on page ${pageId}.`;
      },
    }),
    get_facts: tool({
      description: 'The facts the site may state, with their ids (filter by kind or a search word).',
      inputSchema: z.object({ kind: z.string().max(40).optional(), search: z.string().max(80).optional() }),
      execute: async ({ kind, search }) => {
        const query = search?.toLowerCase();
        const items = facts.facts.filter(
          (fact) =>
            (!kind || fact.kind === kind) &&
            (!query || JSON.stringify(fact.value).toLowerCase().includes(query)),
        );
        return cut(items.slice(0, 60).map((fact) => ({ id: fact.id, kind: fact.kind, value: fact.value })));
      },
    }),
    get_catalog: tool({
      description: 'The block catalog: a block type’s purpose, variants and props (or the list of types).',
      inputSchema: z.object({ blockType: z.string().max(40).optional() }),
      execute: async ({ blockType }) =>
        blockType && (BLOCK_TYPES as readonly string[]).includes(blockType)
          ? cut(blockMarkdown(blockType as BlockType))
          : `Block types: ${BLOCK_TYPES.join(', ')}`,
    }),
    list_assets: tool({
      description: 'The images in the site’s library (ids to use in image props).',
      inputSchema: z.object({}),
      execute: async () => cut((spec as unknown as { assets?: unknown[] }).assets ?? []),
    }),
    propose_operations: tool({
      description:
        'Propose a set of site operations (applied together). They are checked on a dry run: you get problems to fix, or a proposal id. Include a one-sentence summary in the person’s language.',
      inputSchema: z.object({
        operations: z.array(z.record(z.string(), z.unknown())).min(1).max(40),
        summary: z.string().min(1).max(600),
      }),
      execute: async ({ operations, summary }) => {
        const result = await actions.propose(operations, summary);
        return result.ok
          ? `Proposal ${result.proposalId} is ready for the person to review. Stop and summarise it.`
          : `Not valid yet:\n- ${result.problems.join('\n- ')}`;
      },
    }),
    propose_user_fact: tool({
      description:
        'A fact the person just stated about the business (price, hours, service, award…), for them to confirm. It joins your next proposal.',
      inputSchema: z.object({
        kind: z.string().max(40),
        value: z.unknown(),
        locale: z
          .string()
          .regex(/^[a-z]{2}$/)
          .optional(),
        note: z.string().max(300).optional(),
      }),
      execute: async (fact) => {
        const result = actions.proposeFact(fact);
        return result.ok
          ? `Noted as ${result.id}; it will be confirmed with your next proposal.`
          : result.problem;
      },
    }),
    ask_clarification: tool({
      description: 'Ask the person one question, with 2–4 short options, when the request is ambiguous.',
      inputSchema: z.object({
        question: z.string().min(1).max(500),
        options: z.array(z.string().min(1).max(120)).min(2).max(4),
      }),
      execute: async ({ question, options }) => {
        actions.clarify(question, options);
        return 'Asked. Stop and wait for the answer.';
      },
    }),
    refuse: tool({
      description:
        'Decline a request that would mislead (fake reviews, invented awards…), with honest alternatives.',
      inputSchema: z.object({
        reason: z.string().min(1).max(500),
        alternatives: z.array(z.string().min(1).max(200)).min(1).max(4),
      }),
      execute: async ({ reason, alternatives }) => {
        actions.refuse(reason, alternatives);
        return 'Declined. Explain it kindly in one or two sentences.';
      },
    }),
  };
}

@Injectable()
export class AiEditAgent implements EditAgent {
  constructor(@Inject(AI_GATEWAY) private readonly ai: AiGateway) {}

  async run(request: EditAgentRequest, actions: EditAgentActions, emit: (event: EditAgentEvent) => void) {
    const run = await this.ai.agent(
      SitesEditAgent,
      {
        uiLanguage: request.uiLanguage,
        selection: request.selection,
        outline: siteOutline(request.spec),
        brief: request.brief,
        history: '',
        message: request.message,
      },
      { orgId: request.organizationId },
      {
        tools: editTools(request.spec, request.facts, actions),
        maxSteps: MAX_STEPS,
        history: request.history.filter((turn) => turn.content.trim() !== ''),
      },
    );
    let text = '';
    for await (const event of run.events) {
      if (event.type === 'text') {
        text += event.text;
        emit({ type: 'text', text: event.text });
      } else if (event.type === 'tool-call') {
        emit({ type: 'tool', tool: event.tool, summary: summarize(event.tool, event.input) });
      }
    }
    const result = await run.result;
    return { text: text || result.output, costUsd: result.costUsd ?? 0 };
  }
}

import { z } from 'zod';
import { defineTask } from '../define-task.ts';
import { untrusted } from '../untrusted.ts';

// The site editor's chat agent (BF-047): a tool-using text task. Its tools (read the site and facts, propose validated
// operations, ask, refuse) are given by the caller to `gateway.agent`; the model edits only through proposals that a
// person applies. Site texts, facts and the brief are untrusted data; the request is the workspace member's.

export const SiteEditAgentInput = z.object({
  uiLanguage: z.enum(['en', 'fr']),
  /** "Home › Hero (FR), desktop", or "the whole site". */
  selection: z.string().max(300),
  /** The compact outline: pages, blocks with short excerpts, theme, locales. */
  outline: z.string().max(12_000),
  /** Positioning and design direction from the brief, if any. */
  brief: z.string().max(3_000),
  /** The last messages, oldest first, as "role: text" lines. */
  history: z.string().max(8_000),
  message: z.string().min(1).max(4_000),
});
export type SiteEditAgentInput = z.infer<typeof SiteEditAgentInput>;

export const SitesEditAgent = defineTask({
  name: 'sites.edit_agent',
  kind: 'text',
  tier: 'smart',
  prompt: 'sites.edit_agent.v1',
  input: SiteEditAgentInput,
  temperature: 0.3,
  maxOutputTokens: 2_000,
  timeoutMs: 90_000,
  variables: (input) => ({
    uiLanguage: input.uiLanguage === 'fr' ? 'French' : 'English',
    selection: input.selection,
    outline: untrusted('site.outline', input.outline, { maxChars: 12_000 }),
    brief: input.brief ? untrusted('generation.brief', input.brief, { maxChars: 3_000 }) : '(none)',
    history: input.history || '(new conversation)',
    message: input.message,
  }),
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AI_TIERS } from '../define-task.ts';
import { PromptError } from '../errors.ts';
import { renderTemplate } from './render.ts';

const FrontmatterSchema = z.object({
  task: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  version: z.coerce.number().int().min(1),
  tier: z.enum(AI_TIERS),
  output_schema: z.string().optional(),
  changelog: z.string().min(1),
});
export type PromptFrontmatter = z.infer<typeof FrontmatterSchema>;

export interface Prompt {
  /** `<task>.v<N>`. */
  readonly id: string;
  readonly task: string;
  readonly version: number;
  readonly frontmatter: PromptFrontmatter;
  readonly system: string;
  readonly user: string;
  render(variables: Readonly<Record<string, unknown>>): { readonly system: string; readonly user: string };
}

export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));
const FILE = /^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\.v(\d+)\.md$/;

/** `key: value` lines (strings, numbers; optional quotes), enough for prompt frontmatter. */
function parseFrontmatter(block: string, file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) throw new PromptError(`${file}: cannot read frontmatter line "${line}"`);
    values[match[1] as string] = (match[2] as string).replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

export function parsePrompt(file: string, source: string): Prompt {
  const name = FILE.exec(file);
  if (!name) throw new PromptError(`${file}: prompt files are named <task>.v<N>.md`);
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!parts) throw new PromptError(`${file}: missing frontmatter`);
  const parsed = FrontmatterSchema.safeParse(parseFrontmatter(parts[1] as string, file));
  if (!parsed.success) throw new PromptError(`${file}: invalid frontmatter: ${parsed.error.message}`);
  const frontmatter = parsed.data;
  if (frontmatter.task !== name[1] || frontmatter.version !== Number(name[2])) {
    throw new PromptError(`${file}: frontmatter says ${frontmatter.task} v${frontmatter.version}`);
  }
  const body = parts[2] as string;
  const system = /^# System\n([\s\S]*?)(?=^# User\n)/m.exec(body)?.[1]?.trim();
  const user = /^# User\n([\s\S]*)$/m.exec(body)?.[1]?.trim();
  if (!system || !user) throw new PromptError(`${file}: needs a "# System" and a "# User" section`);
  const id = `${frontmatter.task}.v${frontmatter.version}`;
  return {
    id,
    task: frontmatter.task,
    version: frontmatter.version,
    frontmatter,
    system,
    user,
    render: (variables) => ({
      system: renderTemplate(system, variables, `${id} system`).trim(),
      user: renderTemplate(user, variables, `${id} user`).trim(),
    }),
  };
}

export interface PromptRegistry {
  get(id: string): Prompt;
  ids(): readonly string[];
}

/** Every `*.v<N>.md` in `dir`, validated at load (a bad prompt file fails at boot and in tests). */
export function loadPromptRegistry(dir: string = DEFAULT_PROMPTS_DIR): PromptRegistry {
  const prompts = new Map<string, Prompt>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const prompt = parsePrompt(file, readFileSync(join(dir, file), 'utf8'));
    prompts.set(prompt.id, prompt);
  }
  return {
    get(id) {
      const prompt = prompts.get(id);
      if (!prompt) throw new PromptError(`Unknown prompt ${id} (expected prompts/${id}.md)`);
      return prompt;
    },
    ids: () => [...prompts.keys()].sort(),
  };
}

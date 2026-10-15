import { PromptError } from '../errors.ts';

// Logic-less templates: `{{name}}`, `{{a.b}}`, and `{{#each list}}…{{/each}}` (inside: `{{this}}` or item fields).
// A missing variable is an error, never an empty string (ai-engineering.md §3).

const EACH = /\{\{#each ([a-zA-Z_][\w.]*)\}\}([\s\S]*?)\{\{\/each\}\}/g;
const VARIABLE = /\{\{\s*([a-zA-Z_][\w.]*|this)\s*\}\}/g;

function lookup(scope: unknown, path: string, template: string): unknown {
  let value: unknown = scope;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || !(key in value)) {
      throw new PromptError(`Prompt variable "${path}" is missing (${template})`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function scalar(value: unknown, path: string, template: string): string {
  if (value === undefined || value === null)
    throw new PromptError(`Prompt variable "${path}" is empty (${template})`);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  throw new PromptError(`Prompt variable "${path}" is not text (${template}); use {{#each}} for lists`);
}

function substitute(text: string, scope: unknown, template: string): string {
  return text.replace(VARIABLE, (_match, path: string) =>
    scalar(path === 'this' ? scope : lookup(scope, path, template), path, template),
  );
}

export function renderTemplate(
  text: string,
  variables: Readonly<Record<string, unknown>>,
  template = 'prompt',
): string {
  const expanded = text.replace(EACH, (_match, path: string, body: string) => {
    const list = lookup(variables, path, template);
    if (!Array.isArray(list)) throw new PromptError(`Prompt variable "${path}" must be a list for {{#each}}`);
    return list.map((item) => substitute(body, item, template)).join('');
  });
  return substitute(expanded, variables, template);
}

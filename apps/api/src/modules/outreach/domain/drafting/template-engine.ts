import { TEMPLATE_VARIABLES, type TemplateValues, type TemplateVariable } from '@bf/contracts';

// The logic-less template language (BF-051): `{{var}}`, `{{#if var}}…{{else}}…{{/if}}`, `{{#unless var}}…{{/unless}}`,
// `{{#each var}}…{{this}}…{{/each}}`. No expressions, no helpers, no code: a template can only print declared
// variables. Parsing is a single pass over `{{…}}` tags (no backtracking regex).

type Node =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'var'; readonly name: string }
  | {
      readonly kind: 'if' | 'unless';
      readonly name: string;
      readonly whenTrue: Node[];
      readonly otherwise: Node[];
    }
  | { readonly kind: 'each'; readonly name: string; readonly body: Node[] };

export class TemplateSyntaxError extends Error {}

interface Tag {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function tags(source: string): Tag[] {
  const out: Tag[] = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf('{{', at);
    if (open === -1) return out;
    const close = source.indexOf('}}', open + 2);
    if (close === -1) throw new TemplateSyntaxError(`Unclosed tag at ${open}`);
    out.push({ start: open, end: close + 2, content: source.slice(open + 2, close).trim() });
    at = close + 2;
  }
}

export function parseTemplate(source: string): Node[] {
  const list = tags(source);
  let index = 0;
  let cursor = 0;
  const parse = (closing: string | null): { nodes: Node[]; otherwise: Node[] | null } => {
    const nodes: Node[] = [];
    let otherwise: Node[] | null = null;
    let target = nodes;
    while (index < list.length) {
      const tag = list[index] as Tag;
      if (tag.start > cursor) target.push({ kind: 'text', text: source.slice(cursor, tag.start) });
      cursor = tag.end;
      index++;
      const [word = '', name = ''] = tag.content.split(/\s+/, 2);
      if (word === '/if' || word === '/unless' || word === '/each') {
        if (word.slice(1) !== closing) throw new TemplateSyntaxError(`Unexpected {{${word}}}`);
        return { nodes, otherwise };
      }
      if (word === 'else') {
        if (closing !== 'if' && closing !== 'unless')
          throw new TemplateSyntaxError('{{else}} outside a block');
        otherwise = [];
        target = otherwise;
        continue;
      }
      if (word === '#if' || word === '#unless') {
        const inner = parse(word.slice(1));
        target.push({
          kind: word === '#if' ? 'if' : 'unless',
          name,
          whenTrue: inner.nodes,
          otherwise: inner.otherwise ?? [],
        });
        continue;
      }
      if (word === '#each') {
        const inner = parse('each');
        target.push({ kind: 'each', name, body: inner.nodes });
        continue;
      }
      if (word.startsWith('#') || word.startsWith('/'))
        throw new TemplateSyntaxError(`Unknown block {{${word}}}`);
      target.push({ kind: 'var', name: tag.content });
    }
    if (closing) throw new TemplateSyntaxError(`Missing {{/${closing}}}`);
    if (cursor < source.length) target.push({ kind: 'text', text: source.slice(cursor) });
    cursor = source.length;
    return { nodes, otherwise };
  };
  return parse(null).nodes;
}

/** The variable names a template uses (`this` excluded). */
export function usedVariables(source: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.kind === 'var' && node.name !== 'this') names.add(node.name);
      if (node.kind === 'if' || node.kind === 'unless') {
        names.add(node.name);
        walk(node.whenTrue);
        walk(node.otherwise);
      }
      if (node.kind === 'each') {
        names.add(node.name);
        walk(node.body);
      }
    }
  };
  walk(parseTemplate(source));
  return [...names].sort();
}

export const isKnownVariable = (name: string): name is TemplateVariable => name in TEMPLATE_VARIABLES;

const truthy = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);

export class MissingVariableError extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(`Missing required variables: ${names.join(', ')}`);
    this.names = names;
  }
}

/** Renders with the values; a printed variable that is missing is an error (optional ones belong in `{{#if}}`). */
export function renderTemplate(source: string, values: TemplateValues): string {
  const missing = new Set<string>();
  const print = (value: unknown) => (Array.isArray(value) ? value.join(', ') : String(value));
  const run = (nodes: Node[], current: unknown): string =>
    nodes
      .map((node) => {
        switch (node.kind) {
          case 'text':
            return node.text;
          case 'var': {
            if (node.name === 'this') return print(current);
            const value = values[node.name as TemplateVariable];
            if (!truthy(value) && value !== 0 && value !== false) {
              missing.add(node.name);
              return '';
            }
            return print(value);
          }
          case 'if':
          case 'unless': {
            const on = truthy(values[node.name as TemplateVariable]);
            return run((node.kind === 'if' ? on : !on) ? node.whenTrue : node.otherwise, current);
          }
          case 'each': {
            const list = values[node.name as TemplateVariable];
            return Array.isArray(list) ? list.map((item) => run(node.body, item)).join('') : '';
          }
          default:
            return '';
        }
      })
      .join('');
  const out = run(parseTemplate(source), undefined);
  if (missing.size > 0) throw new MissingVariableError([...missing].sort());
  // Blank lines left by empty sections collapse to one.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// The rich-text subset (BF-033): paragraphs, "- " lists, **bold**, *italic* (one level of nesting) and links to the
// site's own pages ([label](page:<id>)). A whitelist parser, linear in the text's length, shared by the validator,
// the renderer (BF-034) and the editor (BF-037). Rendering MUST use its output, never a markdown library: anything
// else — headings, images, reference links and definitions, autolinks, HTML, code — is a problem and stays text.

export type Inline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly Inline[] }
  | { readonly type: 'em'; readonly children: readonly Inline[] }
  | { readonly type: 'link'; readonly pageId: string; readonly children: readonly Inline[] };

export type RichBlock =
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  | { readonly type: 'list'; readonly items: readonly (readonly Inline[])[] };

export interface RichTextResult {
  readonly blocks: readonly RichBlock[];
  /** What is not in the subset (the text should be fixed; the renderer shows the rest as plain text). */
  readonly problems: readonly string[];
  /** Pages the links point to. */
  readonly pageIds: readonly string[];
}

/** A valid link: a bounded label without brackets or line breaks, then a page target (global: replace only). */
const PAGE_LINK = /\[([^[\]\n]{0,200})\]\(page:([a-z][a-z0-9-]{1,31})\)/g;

/**
 * The text with its valid page links replaced by their labels (what the words say); `separator` around each label
 * keeps it from joining the text next to it (`[evil.com](page:home)@x.fr` is not the address `evil.com@x.fr`).
 */
export const withoutPageLinks = (text: string, separator = '') =>
  text.replace(PAGE_LINK, `${separator}$1${separator}`);

const FORBIDDEN_LINE: readonly [RegExp, string][] = [
  [/^\s{0,3}#{1,6}(\s|$)/, 'headings are not allowed (the page has one heading: its hero)'],
  [/^\s{0,3}(=+|-{2,})\s*$/, 'underlined headings and rules are not allowed'],
  [/^\s{0,3}\[[^\]\n]*\]:/, 'reference link definitions are not allowed'],
  [/^\s{0,3}>/, 'quotes are not allowed'],
  [/^\s{0,3}(```|~~~)/, 'code is not allowed'],
  [/^ {4,}\S/, 'indented code is not allowed'],
  [/^\s{0,3}\d+[.)]\s/, 'numbered lists are not allowed (use "- ")'],
  [/^\s{0,3}[*+]\s/, 'use "- " for lists'],
  [/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, 'rules are not allowed'],
  [/^\s{0,3}\|/, 'tables are not allowed'],
];

/** An HTML tag, comment or processing instruction (`<b>`, `</b>`, `<!--`, `<?xml`). */
export const HTML_TAG = /<(?:\/?[a-z!]|\?)[^>\n]*>?/i;

const FORBIDDEN_INLINE: readonly [RegExp, string][] = [
  [HTML_TAG, 'HTML is not allowed'],
  [/<[a-z][a-z0-9+.-]*:[^>\n]*>/i, 'autolinks are not allowed'],
  [/!\[/, 'images are not allowed'],
  [/\]\s*\[/, 'reference links are not allowed'],
  [/`/, 'code is not allowed'],
];

/** Any markdown inline link (bounded): a page link becomes a link, any other keeps only its label. */
const ANY_LINK = /\[([^[\]\n]{0,200})\]\(([^()\n]{0,300})\)/g;
const PAGE_TARGET = /^page:([a-z][a-z0-9-]{1,31})$/;
/** Placeholders for links inside the emphasis pass (private-use characters, removed from the input first). */
const OPEN = '';
const CLOSE = '';
const PLACEHOLDER = /(\d+)/g;

/** Emphasis by delimiter pairing (one pass): `**` strong, `*` em, flanking like CommonMark; `\*` is a star. */
function emphasis(text: string, links: readonly Inline[]): Inline[] {
  type Frame = { size: 1 | 2; children: Inline[] };
  const root: Inline[] = [];
  const stack: Frame[] = [];
  const children = () => stack.at(-1)?.children ?? root;
  const pushText = (value: string) => {
    if (!value) return;
    const list = children();
    const last = list.at(-1);
    if (last?.type === 'text') list[list.length - 1] = { type: 'text', text: last.text + value };
    else list.push({ type: 'text', text: value });
  };
  const push = (value: string) => {
    let last = 0;
    for (const match of value.matchAll(PLACEHOLDER)) {
      pushText(value.slice(last, match.index));
      const link = links[Number(match[1])];
      if (link) children().push(link);
      last = match.index + match[0].length;
    }
    pushText(value.slice(last));
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\' && text[i + 1] === '*') {
      pushText('*');
      i += 2;
      continue;
    }
    if (ch !== '*') {
      let end = i;
      while (end < text.length && text[end] !== '*' && !(text[end] === '\\' && text[end + 1] === '*'))
        end += 1;
      push(text.slice(i, end));
      i = end;
      continue;
    }
    let run = 0;
    while (text[i + run] === '*') run += 1;
    const before = text[i - 1];
    const after = text[i + run];
    const canOpen = after !== undefined && !/\s/u.test(after);
    const canClose = before !== undefined && !/\s/u.test(before);
    i += run;
    while (run > 0) {
      const top = stack.at(-1);
      if (top && canClose && top.size <= run) {
        stack.pop();
        // Empty emphasis (`a****b`) stays as its stars, like CommonMark.
        if (top.children.length === 0) pushText('*'.repeat(top.size * 2));
        else children().push({ type: top.size === 2 ? 'strong' : 'em', children: top.children });
        run -= top.size;
      } else if (canOpen && stack.length < 2) {
        const size: 1 | 2 = run >= 2 && !stack.some((frame) => frame.size === 2) ? 2 : 1;
        stack.push({ size, children: [] });
        run -= size;
      } else {
        pushText('*'.repeat(run));
        run = 0;
      }
    }
  }
  // Unclosed: their stars are text.
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    pushText('*'.repeat(frame.size));
    for (const child of frame.children) {
      if (child.type === 'text') pushText(child.text);
      else children().push(child);
    }
  }
  return root;
}

function inline(text: string, pageIds: string[]): Inline[] {
  const links: Inline[] = [];
  const marked = text
    .replaceAll(OPEN, '')
    .replaceAll(CLOSE, '')
    .replace(ANY_LINK, (_all, label: string, target: string) => {
      const pageId = PAGE_TARGET.exec(target)?.[1];
      const children = emphasis(label, []);
      if (!pageId) return label;
      pageIds.push(pageId);
      links.push({ type: 'link', pageId, children });
      return `${OPEN}${links.length - 1}${CLOSE}`;
    });
  return emphasis(marked, links);
}

export function parseRichText(text: string): RichTextResult {
  const problems = new Set<string>();
  const pageIds: string[] = [];
  const blocks: RichBlock[] = [];
  // Every `](` must belong to a page link (a space, a title or another target is not one).
  // Square brackets are only for page links: anything else ([x](url), references, definitions in any form) is refused.
  const rest = text.replace(PAGE_LINK, '');
  if (rest.includes('](')) problems.add("links go to the site's pages only: [label](page:<id>)");
  else if (/[[\]]/.test(rest)) problems.add('square brackets are only for page links: [label](page:<id>)');
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    for (const line of lines) {
      for (const [pattern, message] of FORBIDDEN_LINE) if (pattern.test(line)) problems.add(message);
      for (const [pattern, message] of FORBIDDEN_INLINE) if (pattern.test(line)) problems.add(message);
    }
    const items = lines.filter((line) => /^\s*- /.test(line));
    if (items.length === lines.length) {
      blocks.push({ type: 'list', items: lines.map((line) => inline(line.replace(/^\s*- /, ''), pageIds)) });
    } else {
      if (items.length > 0) problems.add('put a blank line between a list and a paragraph');
      blocks.push({ type: 'paragraph', children: inline(lines.join(' '), pageIds) });
    }
  }
  return { blocks, problems: [...problems], pageIds };
}

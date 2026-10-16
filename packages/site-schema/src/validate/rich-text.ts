// The rich-text subset (BF-033): paragraphs, "- " lists, **bold**, *italic* and links to the site's own pages
// ([label](page:<id>)). A whitelist parser shared by the validator and the renderer (BF-034) and the editor (BF-037):
// anything else — headings, images, reference links or definitions, autolinks, HTML, code — is a problem, never
// rendered.

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

const FORBIDDEN_LINE: readonly [RegExp, string][] = [
  [/^\s{0,3}#{1,6}\s/, 'headings are not allowed (the page has one heading: its hero)'],
  [/^\s{0,3}\[[^\]]+\]:\s*\S/, 'reference link definitions are not allowed'],
  [/^\s{0,3}>/, 'quotes are not allowed'],
  [/^\s{0,3}(```|~~~)/, 'code is not allowed'],
  [/^ {4,}\S/, 'indented code is not allowed'],
  [/^\s{0,3}\d+[.)]\s/, 'numbered lists are not allowed (use "- ")'],
  [/^\s{0,3}([-*_])(\s*\1){2,}\s*$/, 'rules are not allowed'],
  [/^\s{0,3}\|/, 'tables are not allowed'],
];

const FORBIDDEN_INLINE: readonly [RegExp, string][] = [
  [/<\/?[a-z!][^>]*>?/i, 'HTML is not allowed'],
  [/<[a-z][a-z0-9+.-]*:[^>]*>/i, 'autolinks are not allowed'],
  [/!\[/, 'images are not allowed'],
  [/\]\s*\[/, 'reference links are not allowed'],
  [/`/, 'code is not allowed'],
];

function inline(text: string, problems: string[], pageIds: string[]): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  const plain = (value: string) => {
    if (value) out.push({ type: 'text', text: value });
  };
  while (rest) {
    const link = /\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
    const strong = /\*\*([^*]+)\*\*/.exec(rest);
    const em = /\*([^*]+)\*/.exec(rest);
    const first = [link, strong, em]
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => a.index - b.index || b[0].length - a[0].length)[0];
    if (!first) {
      plain(rest);
      break;
    }
    plain(rest.slice(0, first.index));
    if (first === link) {
      const target = first[2] ?? '';
      const pageId = /^page:([a-z][a-z0-9-]{1,31})$/.exec(target)?.[1];
      if (pageId) {
        pageIds.push(pageId);
        out.push({ type: 'link', pageId, children: inline(first[1] ?? '', problems, pageIds) });
      } else {
        problems.push(`links go to the site's pages only ([label](page:<id>)), not "${target}"`);
        plain(first[1] ?? '');
      }
    } else {
      out.push({
        type: first === strong ? 'strong' : 'em',
        children: inline(first[1] ?? '', problems, pageIds),
      });
    }
    rest = rest.slice(first.index + first[0].length);
  }
  return out;
}

export function parseRichText(text: string): RichTextResult {
  const problems: string[] = [];
  const pageIds: string[] = [];
  const blocks: RichBlock[] = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    for (const line of lines) {
      for (const [pattern, message] of FORBIDDEN_LINE) if (pattern.test(line)) problems.push(message);
      for (const [pattern, message] of FORBIDDEN_INLINE) if (pattern.test(line)) problems.push(message);
    }
    if (lines.every((line) => /^\s*- /.test(line))) {
      blocks.push({
        type: 'list',
        items: lines.map((line) => inline(line.replace(/^\s*- /, ''), problems, pageIds)),
      });
    } else {
      blocks.push({ type: 'paragraph', children: inline(lines.join(' '), problems, pageIds) });
    }
  }
  return { blocks, problems: [...new Set(problems)], pageIds };
}

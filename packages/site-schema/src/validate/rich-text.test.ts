import { describe, expect, it } from 'vitest';
import { parseRichText } from './rich-text.ts';

describe('parseRichText', () => {
  it('reads paragraphs, lists, bold, italic and page links', () => {
    expect(parseRichText('Site by *Island Villas*, see **[home](page:home)**.\n\n- one\n- two')).toEqual({
      blocks: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', text: 'Site by ' },
            { type: 'em', children: [{ type: 'text', text: 'Island Villas' }] },
            { type: 'text', text: ', see ' },
            {
              type: 'strong',
              children: [{ type: 'link', pageId: 'home', children: [{ type: 'text', text: 'home' }] }],
            },
            { type: 'text', text: '.' },
          ],
        },
        { type: 'list', items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]] },
      ],
      problems: [],
      pageIds: ['home'],
    });
  });

  it.each([
    ['# Big title', 'headings'],
    ['[x][r]\n\n[r]: //evil.example/phish', 'reference link'],
    ['[x][r]\n\n[r]: javascript:alert(1)', 'reference link'],
    ['![p](page:home)', 'images'],
    ['![p][r]\n\n[r]: //tracker.example/px.gif', 'images'],
    ['<b>hi</b>', 'HTML'],
    ['<https://evil.example>', 'autolinks'],
    ['see [x](https://evil.example)', 'links go to'],
    ['see [x](//evil.example)', 'links go to'],
    ['see [x](javascript:alert(1))', 'links go to'],
    ['`code`', 'code'],
    ['> quote', 'quotes'],
    ['1. first', 'numbered'],
    ['---', 'rules'],
  ])('refuses %j', (text, problem) => {
    expect(parseRichText(text).problems.join(' | ')).toContain(problem);
  });

  it('never yields a link to anything but a page', () => {
    const { blocks } = parseRichText('[a](https://x.example) [b](page:about)');
    const links = JSON.stringify(blocks).match(/"type":"link"/g) ?? [];
    expect(links).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain('https://');
  });
});

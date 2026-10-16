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
    ['see [x]( https://evil.example/x)', 'links go to'],
    ['see [x](https://evil.example/x "t")', 'links go to'],
    ['[r]\n\n[r]:\njavascript:alert(1)', 'reference link definitions'],
    ['Title\n=====', 'underlined headings'],
    ['* item', 'use "- "'],
    ['+ item', 'use "- "'],
    ['- item\nprose', 'blank line'],
    ['Réservez [ici]\n\n[ici\n]: &#x2F;&#x2F;evil&#x2E;xyz', 'square brackets'],
    ['[\nr]: javascript:alert(1)\n\n[r]', 'square brackets'],
    ['[a\\]b]\n\n[a\\]b]: javascript:alert(1)', 'square brackets'],
    ['- [r]: javascript:alert(1)\n\n[r]', 'square brackets'],
    ['- [r]: &#x2F;&#x2F;evil&#x2E;xyz\n\n- [r]', 'square brackets'],
    ['<?xml x?>', 'HTML'],
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

  it.each([
    [
      '***both***',
      [{ type: 'strong', children: [{ type: 'em', children: [{ type: 'text', text: 'both' }] }] }],
    ],
    [
      '**bold *italic* bold**',
      [
        {
          type: 'strong',
          children: [
            { type: 'text', text: 'bold ' },
            { type: 'em', children: [{ type: 'text', text: 'italic' }] },
            { type: 'text', text: ' bold' },
          ],
        },
      ],
    ],
    ['Menu* and conditions* apply', [{ type: 'text', text: 'Menu* and conditions* apply' }]],
    ['5 * 3 * 2', [{ type: 'text', text: '5 * 3 * 2' }]],
    ['a \\*literal\\* star', [{ type: 'text', text: 'a *literal* star' }]],
    ['**open only', [{ type: 'text', text: '**open only' }]],
    ['a****b', [{ type: 'text', text: 'a****b' }]],
  ])('reads emphasis like CommonMark: %j', (text, children) => {
    expect(parseRichText(text).blocks).toEqual([{ type: 'paragraph', children }]);
  });

  it.each(['[*', '[**', '[(*', '[*a', '*a* [', '[x](', '**a'])(
    'parses 5,000 characters of %j in linear time',
    (unit) => {
      const text = unit.repeat(Math.floor(5000 / unit.length));
      const started = performance.now();
      parseRichText(text);
      expect(performance.now() - started).toBeLessThan(50);
    },
  );
});

import { describe, expect, it } from 'vitest';
import { PromptError } from '../errors.ts';
import { loadPromptRegistry, parsePrompt } from './registry.ts';
import { renderTemplate } from './render.ts';

const valid = `---
task: test.greet
version: 2
tier: fast
changelog: "Greets"
---
# System
You greet people.

# User
Hello {{name}} from {{place.city}}.
{{#each items}}- {{this}}
{{/each}}`;

describe('prompt files', () => {
  it('parses frontmatter and sections', () => {
    const prompt = parsePrompt('test.greet.v2.md', valid);
    expect(prompt).toMatchObject({
      id: 'test.greet.v2',
      task: 'test.greet',
      version: 2,
      system: 'You greet people.',
    });
    expect(prompt.render({ name: 'Ana', place: { city: 'Gustavia' }, items: ['a', 'b'] }).user).toBe(
      'Hello Ana from Gustavia.\n- a\n- b',
    );
  });

  it.each([
    ['test.greet.md', valid, /named <task>\.v<N>\.md/],
    ['test.greet.v3.md', valid, /frontmatter says test\.greet v2/],
    ['test.greet.v2.md', valid.replace('tier: fast', 'tier: huge'), /invalid frontmatter/],
    ['test.greet.v2.md', valid.replace('changelog: "Greets"\n', ''), /invalid frontmatter/],
    ['test.greet.v2.md', valid.replace('# User', '# Assistant'), /"# System" and a "# User"/],
    ['test.greet.v2.md', 'no frontmatter', /missing frontmatter/],
  ])('rejects %s (%#)', (file, source, message) => {
    expect(() => parsePrompt(file, source)).toThrow(message);
  });

  it('loads and validates every prompt shipped with the package', () => {
    const registry = loadPromptRegistry();
    expect(registry.ids()).toContain('demo.extract_business_facts.v1');
    expect(() => registry.get('nope.v1')).toThrow(PromptError);
  });
});

describe('rendering', () => {
  it('fails on missing, empty or non-text variables instead of rendering blanks', () => {
    expect(() => renderTemplate('Hi {{name}}', {})).toThrow(/"name" is missing/);
    expect(() => renderTemplate('Hi {{name}}', { name: null })).toThrow(/is empty/);
    expect(() => renderTemplate('Hi {{name}}', { name: { first: 'A' } })).toThrow(/not text/);
    expect(() => renderTemplate('{{#each name}}x{{/each}}', { name: 'A' })).toThrow(/must be a list/);
    expect(() => renderTemplate('{{#each list}}{{missing}}{{/each}}', { list: [{}] })).toThrow(/missing/);
  });

  it('renders numbers, booleans and item fields', () => {
    expect(
      renderTemplate('{{n}} {{ok}} {{#each xs}}[{{id}}]{{/each}}', {
        n: 3,
        ok: true,
        xs: [{ id: 1 }, { id: 2 }],
      }),
    ).toBe('3 true [1][2]');
  });

  it('never expands placeholders that come from data (single pass)', () => {
    expect(
      renderTemplate('{{a}} / {{#each xs}}{{this}};{{/each}}', { a: '{{b}}', b: 'secret', xs: ['{{b}}'] }),
    ).toBe('{{b}} / {{b}};');
  });
});

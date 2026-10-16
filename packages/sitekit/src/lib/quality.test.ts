import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SiteSpec } from '@bf/site-schema';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from './check.ts';
import { loadConfig, SitekitConfigSchema } from './config.ts';
import { applyLintFixes, frenchTypography, LINT_RULES, lintCopy, rules, tidyWhitespace } from './lint.ts';
import { readFacts } from './readers.ts';
import { renderSite } from './render.ts';
import type { Shooter } from './screenshot.ts';
import { asSpec, readSiteRaw } from './site.ts';
import { Workspace } from './workspace.ts';

// Copy lint, render and check (BF-042). The browser runs in screenshot.browser.test.ts; here screenshots are stubbed.

const CSS = 'body{margin:0}';
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/workspace-${name}/`, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'sitekit-quality-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A writable copy of a fixture workspace. */
async function copy(name: string) {
  const dir = join(scratch, `${name}-${Math.random().toString(36).slice(2)}`);
  cpSync(fixture(name), dir, { recursive: true });
  const workspace = await Workspace.open(dir);
  const config = await loadConfig(workspace);
  const spec = asSpec((await readSiteRaw(workspace, config)).value) as SiteSpec;
  return { workspace, config, spec, facts: await readFacts(workspace) };
}

function withText(spec: SiteSpec, fr: string, en = 'Book your cut today.'): SiteSpec {
  const next = structuredClone(spec);
  const hero = next.pages[0]?.blocks[0] as { props: { subtitle?: Record<string, string> } };
  hero.props.subtitle = { fr, en };
  return next;
}

describe('lintCopy', () => {
  it('passes the fixture sites without errors', async () => {
    for (const name of ['salon', 'cafe']) {
      const { spec, config, facts } = await copy(name);
      const errors = lintCopy(spec, { config, ...(facts ? { facts } : {}) }).filter(
        (i) => i.severity === 'error',
      );
      expect(errors).toEqual([]);
    }
  });

  it('finds placeholders, superlatives, invented numbers, clichés and wrong languages', async () => {
    const { spec, config, facts } = await copy('salon');
    const text = 'Le meilleur salon de l’île, au cœur de Gustavia, depuis 25 ans. Lorem ipsum.';
    const issues = lintCopy(
      withText(spec, text, 'Le salon est ouvert pour vous et nous sommes là pour les clients.'),
      {
        config,
        ...(facts ? { facts } : {}),
      },
    );
    const at = (rule: string) =>
      issues.filter((issue) => issue.rule === rule && issue.at.includes('subtitle'));
    expect(at('copy.superlative')[0]).toMatchObject({ severity: 'error', locale: 'fr' });
    expect(at('copy.unsupported_number')[0]?.message).toContain('25');
    expect(at('copy.placeholder')).toHaveLength(1);
    expect(at('copy.cliche')[0]?.message).toContain('au cœur de');
    expect(at('copy.wrong_language')[0]).toMatchObject({ locale: 'en' });
  });

  it('accepts a superlative backed by an award fact, and honours severity overrides', async () => {
    const { spec, config, facts } = await copy('salon');
    const awarded = {
      facts: [
        ...(facts?.facts ?? []),
        { id: 'award.1', kind: 'award' as const, value: 'Prix', source: 'website', confidence: 1 },
      ],
    };
    const target = withText(spec, 'Le meilleur salon de l’île.');
    expect(lintCopy(target, { config, facts: awarded }).some((i) => i.rule === 'copy.superlative')).toBe(
      false,
    );
    const quiet = SitekitConfigSchema.parse({
      ...config,
      lint: { 'copy.superlative': 'off', 'copy.cliche': 'error' },
    });
    const issues = lintCopy(withText(spec, 'Le meilleur salon, au cœur de Gustavia.'), {
      config: quiet,
      ...(facts ? { facts } : {}),
    });
    expect(issues.some((i) => i.rule === 'copy.superlative')).toBe(false);
    expect(issues.find((i) => i.rule === 'copy.cliche')?.severity).toBe('error');
  });

  it('checks CTA verbs, SEO lengths, alt texts, long sentences and duplicates', async () => {
    const { spec, config, facts } = await copy('salon');
    const next = structuredClone(spec);
    next.layout.header.cta = { kind: 'call', label: { fr: 'Notre numéro', en: 'Our number' } } as never;
    next.seo.title = { fr: 'Salon', en: 'Salon' };
    const asset = next.assets[0];
    if (asset) asset.alt = { fr: 'IMG_2041.jpg', en: 'image of the salon' };
    const long =
      'Nous coupons et coloriez avec soin chaque jour de la semaine pour toutes les personnes qui viennent dans notre salon lumineux sur le port de Gustavia avec une équipe passionnée et attentive.';
    const blocks = next.pages[0]?.blocks as { props: Record<string, unknown> }[];
    (blocks[0] as { props: Record<string, unknown> }).props.subtitle = {
      fr: long,
      en: 'A bright salon by the harbour, for a cut done with care.',
    };
    const repeated = {
      fr: 'Un salon lumineux sur le port, pour une coupe faite avec soin.',
      en: 'A bright salon by the harbour, for a cut done with care.',
    };
    (blocks[1] as { props: Record<string, unknown> }).props.heading = repeated;
    const issues = lintCopy(next, { config, ...(facts ? { facts } : {}) });
    const rulesFound = new Set(issues.map((issue) => issue.rule));
    for (const rule of [
      'copy.cta_verb',
      'copy.seo_length',
      'copy.alt_text',
      'copy.sentence_length',
      'copy.duplicate',
    ])
      expect(rulesFound.has(rule as never), rule).toBe(true);
    expect(issues.filter((issue) => issue.rule === 'copy.alt_text')).toHaveLength(2);
  });

  it('fixes French typography and whitespace safely, and only those', async () => {
    expect(frenchTypography("Où nous trouver ? L'équipe : « Bonjour »")).toBe(
      'Où nous trouver ? L’équipe : « Bonjour »',
    );
    expect(frenchTypography('https://www.planity.com/salon?x=1')).toBe('https://www.planity.com/salon?x=1');
    expect(tidyWhitespace('  Deux  espaces ')).toBe('Deux espaces');
    const { spec, config, facts } = await copy('salon');
    const dirty = withText(spec, "L'équipe  vous accueille ! Le meilleur salon.");
    const issues = lintCopy(dirty, { config, ...(facts ? { facts } : {}) });
    const { spec: fixed, fixed: count } = applyLintFixes(dirty, issues);
    expect(count).toBe(issues.filter((issue) => issue.fix !== undefined).length);
    const subtitle = (
      fixed.pages[0]?.blocks[0] as unknown as { props: { subtitle: Record<string, string> } } | undefined
    )?.props.subtitle.fr;
    expect(subtitle).toBe('L’équipe vous accueille ! Le meilleur salon.');
    expect(
      lintCopy(fixed, { config, ...(facts ? { facts } : {}) }).some((i) => i.rule === 'copy.superlative'),
    ).toBe(true);
  });

  it('keeps every rule documented in the data files', () => {
    const { common, locales } = rules();
    expect(common.placeholders.length).toBeGreaterThan(5);
    expect(locales.get('fr')?.cliches.length).toBeGreaterThan(5);
    expect(locales.get('en')?.superlatives.length).toBeGreaterThan(3);
    expect(LINT_RULES).toHaveLength(12);
  });
});

describe('renderSite and check', () => {
  it('renders every page in every locale with a review index', async () => {
    const { workspace, spec } = await copy('salon');
    const result = await renderSite(workspace, spec, { css: CSS });
    expect(result.pages).toHaveLength(spec.pages.length * spec.locales.length);
    expect(await workspace.readText(result.pages[0]?.file as string)).toContain('<!doctype html>');
    expect(await workspace.readText(result.index)).toContain('/en/');
    expect(await workspace.readText('.sitekit/render/styles.css')).toBe(CSS);
    const again = await renderSite(workspace, spec, { css: CSS });
    expect(await workspace.readText(again.pages[0]?.file as string)).toBe(
      await workspace.readText(result.pages[0]?.file as string),
    );
    const only = await renderSite(workspace, spec, { css: CSS, pages: ['home'], locales: ['fr'] });
    expect(only.pages.map((page) => [page.pageId, page.locale])).toEqual([['home', 'fr']]);
  });

  const shooter: Shooter = async (_workspace, _spec, _dir, requests) =>
    requests.map((request) => ({ ...request, file: `x/${request.viewport}.png`, width: 390, height: 844 }));

  it('is done for a valid site, and lists what blocks a broken one', async () => {
    const ok = await check((await copy('salon')).workspace, { shooter, css: CSS });
    expect(ok).toMatchObject({
      done: true,
      blocking: [],
      counts: { validationErrors: 0, lintErrors: 0, screenshots: 2 },
    });
    expect(ok.counts.pagesRendered).toBeGreaterThan(0);
    const broken = await check((await copy('broken')).workspace, { shooter, css: CSS });
    expect(broken.done).toBe(false);
    expect(broken.blocking.map((item) => item.kind)).toEqual(expect.arrayContaining(['validate']));
    expect(broken.blocking.every((item) => item.message.length > 0)).toBe(true);
  });

  it('is not done when screenshots fail or the workspace is unreadable', async () => {
    const failing: Shooter = async () => Promise.reject(new Error('no browser'));
    const report = await check((await copy('salon')).workspace, { shooter: failing, css: CSS });
    expect(report.done).toBe(false);
    expect(report.blocking).toEqual([
      expect.objectContaining({ kind: 'screenshot', message: expect.stringContaining('no browser') }),
    ]);
    const empty = await check(await Workspace.open(mkdtempSync(join(scratch, 'empty-'))), {
      shooter,
      css: CSS,
    });
    expect(empty).toMatchObject({ done: false, blocking: [expect.objectContaining({ kind: 'workspace' })] });
  });
});

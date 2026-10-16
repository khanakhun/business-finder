import { apply, type SiteSpec, SiteSpecSchema, validateSite } from '@bf/site-schema';
import cafe from '@bf/site-schema/fixtures/cafe-saint-jean.json' with { type: 'json' };
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { PAGE_TEMPLATES, pageFromTemplate } from './page-templates.ts';

const sites = [salon, cafe].map((spec) => SiteSpecSchema.parse(spec) as SiteSpec);
const options = (spec: SiteSpec) => ({ spec, placeholder: () => 'New text', title: 'Our page' });

describe('pageFromTemplate', () => {
  it.each(PAGE_TEMPLATES)('makes a %s page the site accepts, or none', (template) => {
    for (const spec of sites) {
      const page = pageFromTemplate(template, spec, options(spec));
      if (!page) continue;
      const added = apply(spec, { op: 'addPage', page }).spec;
      expect(added.pages.at(-1)?.id).toBe(page.id);
      // Nothing structural to fix (missing translations are expected: the default language only).
      const errors = validateSite(added, { assetHosts: ['assets.bf-sites.test'], mode: 'preview' }).filter(
        (issue) => issue.severity === 'error' && issue.code !== 'locale_missing',
      );
      expect(errors, `${template} on ${spec.brand.name}`).toEqual([]);
    }
  });

  it('gives a free id and slug when the template was used already', () => {
    const spec = sites[0] as SiteSpec;
    const first = pageFromTemplate('faq', spec, options(spec));
    if (!first) throw new Error('faq is always possible');
    const withFaq = apply(spec, { op: 'addPage', page: first }).spec;
    const second = pageFromTemplate('faq', withFaq, options(withFaq));
    expect(second?.id).toBe('faq-2');
    expect(second?.slug).toBe('faq-2');
  });

  it('offers no gallery page to a site with fewer images than a gallery needs', () => {
    const spec = { ...(sites[0] as SiteSpec), assets: [] };
    expect(pageFromTemplate('gallery', spec, options(spec))).toBeUndefined();
  });
});

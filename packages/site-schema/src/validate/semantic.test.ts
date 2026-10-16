import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '../spec/site.ts';
import type { Issue } from './issues.ts';
import { parseSite, validateSite } from './semantic.ts';

// Each rule of the semantic validator on its own (the fixtures test the rules together).

const salon = (): SiteSpec =>
  JSON.parse(readFileSync(new URL('../../fixtures/salon-gustavia.json', import.meta.url), 'utf8'));
const OPTIONS = { assetHosts: ['assets.bf-sites.test'] };
const found = (spec: unknown, options = OPTIONS) =>
  validateSite(spec, options).map((issue: Issue) => `${issue.code}@${issue.path.join('.')}`);
const with_ = (change: (spec: SiteSpec) => void) => {
  const spec = salon();
  change(spec);
  return spec;
};
const L = (text: string) => ({ fr: text, en: text });

describe('validateSite', () => {
  it('turns schema problems into issues, an over-long text with its own code', () => {
    const issues = validateSite(
      with_((s) => {
        const hero = s.pages[0]?.blocks[0];
        if (hero?.type === 'hero') hero.props.title.fr = 'x'.repeat(61);
      }),
      OPTIONS,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'text_too_long',
        path: ['pages', 0, 'blocks', 0, 'props', 'title', 'fr'],
      }),
    ]);
    expect(parseSite({ schemaVersion: 2 }).spec).toBeNull();
  });

  it('checks the languages: default among them, each once, no text for another one', () => {
    expect(found(with_((s) => Object.assign(s, { defaultLocale: 'de' })))).toContain(
      'default_locale_unknown@defaultLocale',
    );
    expect(found(with_((s) => Object.assign(s, { locales: ['fr', 'en', 'fr'] })))).toContain(
      'duplicate_locale@locales',
    );
    const extra = validateSite(
      with_((s) => Object.assign(s.seo.title, { de: 'Salon' })),
      OPTIONS,
    );
    expect(extra).toEqual([
      expect.objectContaining({ code: 'locale_missing', severity: 'warning', path: ['seo', 'title', 'de'] }),
    ]);
  });

  it('needs a home page and unique slugs, page ids and element ids', () => {
    expect(found(with_((s) => Object.assign(s.pages[0] ?? {}, { slug: 'accueil' })))).toContain(
      'home_missing@pages',
    );
    expect(found(with_((s) => Object.assign(s.pages[2] ?? {}, { slug: 'prestations' })))).toContain(
      'duplicate_slug@pages.2.slug',
    );
    expect(found(with_((s) => Object.assign(s.pages[2] ?? {}, { id: 'services' })))).toContain(
      'duplicate_page_id@pages.2.id',
    );
    expect(found(with_((s) => Object.assign(s.pages[1]?.blocks[0] ?? {}, { id: 'hero-home1' })))).toContain(
      'duplicate_element_id@pages.1.blocks.0.id',
    );
  });

  it('resolves asset references by kind', () => {
    expect(found(with_((s) => Object.assign(s.layout.header, { logoAssetId: 'img-salon-1' })))).toContain(
      'asset_kind@layout.header.logoAssetId',
    );
    const gallery = with_((s) =>
      s.pages[0]?.blocks.push({
        id: 'gall-home9',
        type: 'gallery',
        variant: 'grid',
        props: { assetIds: ['img-salon-1', 'logo-lumiere', 'nope-1234'] },
      }),
    );
    expect(found(gallery)).toEqual(
      expect.arrayContaining([
        'asset_kind@pages.0.blocks.5.props.assetIds.1',
        'unknown_asset@pages.0.blocks.5.props.assetIds.2',
      ]),
    );
  });

  it('needs an image for split and full-image heroes', () => {
    expect(
      found(
        with_((s) => {
          const hero = s.pages[0]?.blocks[0];
          if (hero?.type === 'hero') delete hero.props.imageAssetId;
        }),
      ),
    ).toContain('hero_image_missing@pages.0.blocks.0.props.imageAssetId');
  });

  it.each([
    ['email', 'email'],
    ['whatsapp', 'whatsapp'],
    ['directions', 'address'],
  ] as const)('refuses a %s action without the contact fact', (kind, fact) => {
    const spec = with_((s) => {
      delete s.contact[fact];
      if (fact === 'address') delete s.contact.geo;
      s.layout.header.cta = { kind, label: L('Go') };
    });
    expect(found(spec)).toContain('cta_unresolved@layout.header.cta');
  });

  it('checks page and url actions', () => {
    const page = with_((s) =>
      Object.assign(s.layout.header, { cta: { kind: 'page', label: L('Go'), pageId: 'nowhere' } }),
    );
    expect(found(page)).toContain('unknown_page@layout.header.cta.pageId');
    const noUrl = with_((s) => Object.assign(s.layout.header, { cta: { kind: 'url', label: L('Go') } }));
    expect(found(noUrl)).toContain('cta_unresolved@layout.header.cta.url');
    const external = with_((s) =>
      Object.assign(s.layout.header, {
        cta: { kind: 'url', label: L('Go'), url: 'https://elsewhere.example/x' },
      }),
    );
    expect(found(external)).toContain('external_url@layout.header.cta.url');
    const own = with_((s) =>
      Object.assign(s.layout.header, {
        cta: { kind: 'url', label: L('Go'), url: 'https://www.salon-lumiere.example/gift' },
      }),
    );
    expect(found(own, { ...OPTIONS, ownDomains: ['salon-lumiere.example'] } as never)).toEqual([]);
  });

  it('checks the header and footer against the contact facts', () => {
    expect(found(with_((s) => delete s.layout.header.cta))).toContain('cta_missing@layout.header.cta');
    expect(found(with_((s) => delete s.contact.socials))).toContain(
      'block_requirement@layout.footer.showSocials',
    );
  });

  it('keeps social links on their network', () => {
    const spec = with_((s) =>
      Object.assign(s.contact, {
        socials: [{ network: 'instagram', url: 'https://www.facebook.com/salon' }],
      }),
    );
    expect(found(spec)).toContain('social_host@contact.socials.0.url');
  });

  it('needs a way to reach the business', () => {
    const spec = with_((s) => {
      delete s.contact.phone;
      delete s.contact.email;
      s.settings.contactForm.enabled = false;
      s.layout.header.cta = { kind: 'booking', label: L('Book') };
      for (const page of s.pages)
        for (const block of page.blocks) if (block.type === 'hero') delete block.props.secondaryCta;
      s.pages[2]?.blocks.splice(1, 1);
    });
    expect(found(spec)).toEqual(['no_contact_channel@contact']);
  });

  it('checks the contact block against the facts and the form setting', () => {
    const spec = with_((s) => {
      s.settings.contactForm.enabled = false;
      const block = s.pages[2]?.blocks[1];
      if (block?.type === 'contact') block.props.channels.whatsapp = true;
    });
    expect(found(spec)).toEqual(
      expect.arrayContaining([
        'block_requirement@pages.2.blocks.1.props.showForm',
        'block_requirement@pages.2.blocks.1.props.channels.whatsapp',
      ]),
    );
    const empty = with_((s) => {
      const block = s.pages[2]?.blocks[1];
      if (block?.type === 'contact')
        Object.assign(block.props, {
          showForm: false,
          channels: { phone: false, email: false, whatsapp: false },
        });
    });
    expect(found(empty)).toContain('block_requirement@pages.2.blocks.1.props');
  });

  it('needs the facts behind location and social link blocks', () => {
    const spec = with_((s) => {
      delete s.contact.address;
      delete s.contact.geo;
      delete s.contact.socials;
      s.layout.footer.showSocials = false;
      s.pages[0]?.blocks.push({ id: 'soci-home9', type: 'social_links', variant: 'icons', props: {} });
    });
    expect(found(spec)).toEqual(
      expect.arrayContaining(['block_requirement@pages.2.blocks.3', 'block_requirement@pages.0.blocks.5']),
    );
  });

  it('links rich text only to existing pages', () => {
    const spec = with_((s) =>
      s.pages[1]?.blocks.push({
        id: 'rich-serv9',
        type: 'rich_text',
        variant: 'narrow',
        props: { body: L('See [it](page:gone)') },
      }),
    );
    expect(found(spec)).toContain('unknown_page@pages.1.blocks.2.props.body.fr');
  });

  it('warns about texts outside their recommended length', () => {
    const issues = validateSite(
      with_((s) => Object.assign(s.seo.description, { en: 'Too short.' })),
      OPTIONS,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'text_length',
        severity: 'warning',
        path: ['seo', 'description', 'en'],
      }),
    ]);
  });

  it('suggests a colour that reaches the contrast', () => {
    const [issue] = validateSite(
      with_((s) => Object.assign(s.theme.palette, { mutedText: '#b5aaa0' })),
      OPTIONS,
    );
    expect(issue).toMatchObject({ code: 'contrast_low', path: ['theme', 'palette', 'mutedText'] });
    expect(issue?.message).toMatch(/try #[0-9a-f]{6}/);
  });
});

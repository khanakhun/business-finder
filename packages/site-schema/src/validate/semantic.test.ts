import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SiteSpec } from '../spec/site.ts';
import type { Issue } from './issues.ts';
import { onColor, parseSite, type ValidateOptions, validateSite } from './semantic.ts';

// Each rule of the semantic validator on its own (the fixtures test the rules together).

const salon = (): SiteSpec =>
  JSON.parse(readFileSync(new URL('../../fixtures/salon-gustavia.json', import.meta.url), 'utf8'));
const OPTIONS = { assetHosts: ['assets.bf-sites.test'] };
const found = (spec: unknown, options: ValidateOptions = OPTIONS) =>
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
      expect.objectContaining({ code: 'locale_extra', severity: 'warning', path: ['seo', 'title', 'de'] }),
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
    ).toContain('image_missing@pages.0.blocks.0.props.imageAssetId');
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
    expect(found(noUrl)).toContain('schema@layout.header.cta.url');
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
    expect(found(own, { ...OPTIONS, ownDomains: ['salon-lumiere.example'] })).toEqual([]);
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
        socials: [
          { network: 'instagram', url: 'https://www.facebook.com/salon', factId: 'social.instagram' },
        ],
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

  it.each([
    'Visitez evil.\u034Fcom',
    'evil.\uFE0Fcom',
    'evil.\u{E0100}com',
    'Appelez le \u0660\u0666\u0669\u0660 12 34 56',
    'Depuis \u0967\u096F\u096F\u096E',
    'Visitez evil\uE000.com',
    'Visitez evil\u0378.com',
  ])('refuses hidden marks and look-alike digits in text: %j', (title) => {
    expect(parseSite(with_((s) => Object.assign(s.seo.title, { en: title }))).spec).toBeNull();
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

  it('keeps a preview unindexed and bannered (unless published)', () => {
    const live = with_((s) => Object.assign(s.settings, { noindex: false, previewBanner: false }));
    expect(found(live)).toEqual([
      'preview_settings@settings.noindex',
      'preview_settings@settings.previewBanner',
    ]);
    expect(found(live, { ...OPTIONS, mode: 'published' })).toEqual([]);
  });

  it('lets an action carry only what its kind uses', () => {
    const smuggled = with_((s) =>
      Object.assign(s.layout.header, {
        cta: { kind: 'call', label: L('Go'), url: 'https://evil.example/x' },
      }),
    );
    expect(found(smuggled)[0]).toMatch(/^schema@layout\.header\.cta/);
  });

  it('needs a fact behind every contact detail', () => {
    expect(
      found(with_((s) => s.contact.phone && delete (s.contact.phone as { factId?: string }).factId)),
    ).toEqual(['schema@contact.phone.factId']);
  });

  it.each([
    [
      'the footer tagline',
      (s: SiteSpec) => Object.assign(s.layout.footer, { tagline: L('See www.evil.example') }),
      'layout.footer.tagline.fr',
    ],
    [
      'the site description',
      (s: SiteSpec) =>
        Object.assign(s.seo.description, {
          en: 'Visit https://evil.example for more about our salon, prices and hours in Gustavia, St Barth.',
        }),
      'seo.description.en',
    ],
    [
      'a bare domain',
      (s: SiteSpec) => Object.assign(s.seo.title, { en: 'Go to evil-site.com now' }),
      'seo.title.en',
    ],
    [
      'a protocol-relative link',
      (s: SiteSpec) => Object.assign(s.seo.title, { fr: 'Voir //evil.example/x' }),
      'seo.title.fr',
    ],
    [
      'a plain text field',
      (s: SiteSpec) =>
        s.contact.address && Object.assign(s.contact.address, { formatted: 'www.evil.example' }),
      'contact.address.formatted',
    ],
  ] as const)('refuses a web address in %s', (_case, change, path) => {
    expect(found(with_(change))).toContain(`external_url@${path}`);
  });

  it('leaves e-mail addresses in text to the facts validator', () => {
    expect(
      found(with_((s) => Object.assign(s.layout.footer, { tagline: L('bonjour@salon-lumiere.example') }))),
    ).toEqual([]);
  });

  it('refuses HTML in any text', () => {
    const spec = with_((s) => {
      const hero = s.pages[0]?.blocks[0];
      if (hero?.type === 'hero') hero.props.title.en = '<img src=x onerror=alert(1)>';
    });
    expect(found(spec)).toContain('html@pages.0.blocks.0.props.title.en');
  });

  it.each([
    ['a user page on google.com', 'google', 'https://sites.google.com/view/attacker'],
    ['a redirect page', 'facebook', 'https://www.facebook.com/l.php?u=https://evil.example'],
    ['a query string', 'instagram', 'https://www.instagram.com/salonlumiere?next=https://evil.example'],
    ['the network home page', 'instagram', 'https://www.instagram.com/'],
    ['a port', 'instagram', 'https://www.instagram.com:8443/salonlumiere'],
  ])('refuses %s as a social profile', (_case, network, url) => {
    const spec = with_((s) =>
      Object.assign(s.contact, { socials: [{ network, url, factId: 'social.instagram' }] }),
    );
    expect(found(spec)).toContain('social_host@contact.socials.0.url');
  });

  it('matches asset hosts exactly and refuses credentials in URLs', () => {
    const sub = with_((s) =>
      Object.assign(s.assets[1] ?? {}, { url: 'https://evil.assets.bf-sites.test/x.jpg' }),
    );
    expect(found(sub)).toContain('asset_host@assets.1.url');
    const creds = with_((s) =>
      Object.assign(s.contact.bookingUrl ?? {}, { value: 'https://user:pass@www.planity.com/x' }),
    );
    expect(found(creds)).toContain('external_url@contact.bookingUrl.value');
  });

  it('refuses reserved slugs and hidden characters', () => {
    expect(found(with_((s) => Object.assign(s.pages[1] ?? {}, { slug: 'en' })))).toEqual([
      'schema@pages.1.slug',
    ]);
    const hidden = with_((s) => Object.assign(s.seo.title, { en: 'Salon \u202eLumière' }));
    expect(found(hidden)).toEqual(['schema@seo.title.en']);
  });

  it('needs an image for every variant that shows one', () => {
    const spec = with_((s) => {
      const banner = s.pages[0]?.blocks[4];
      if (banner?.type === 'cta_banner') banner.variant = 'image';
    });
    expect(found(spec)).toEqual(['image_missing@pages.0.blocks.4.props.imageAssetId']);
  });

  it('checks muted text on the surface, the secondary colour, and button labels on primary', () => {
    expect(found(with_((s) => Object.assign(s.theme.palette, { surface: '#d8d0c4' })))).toContain(
      'contrast_low@theme.palette.mutedText',
    );
    expect(found(with_((s) => Object.assign(s.theme.palette, { secondary: '#eeeeee' })))).toContain(
      'contrast_low@theme.palette.secondary',
    );
    expect(onColor('#7a5c3e')).toBe('#ffffff');
    expect(onColor('#f0e000')).toBe('#000000');
  });

  it("sends url actions to the business's own domain only, without a carried URL", () => {
    const cta = (url: string) =>
      with_((s) => Object.assign(s.layout.header, { cta: { kind: 'url', label: L('Go'), url } }));
    const own = { ...OPTIONS, ownDomains: ['salon-lumiere.example'] };
    expect(found(cta('https://calendly.com/attacker/deposit'), own)).toContain(
      'external_url@layout.header.cta.url',
    );
    expect(found(cta('https://www.salon-lumiere.example/go?to=https://evil.example'), own)).toContain(
      'external_url@layout.header.cta.url',
    );
    const booking = with_((s) =>
      Object.assign(s.contact.bookingUrl ?? {}, {
        value: 'https://www.planity.com/r?u=https%3A%2F%2Fevil.example',
      }),
    );
    expect(found(booking)).toContain('external_url@contact.bookingUrl.value');
  });

  it.each([
    'Venez sur evil-shop.de',
    'Notre site salon.bl',
    'Voir café-lumière.fr',
    'Voir evil\u3002com',
    'Voir \uFF57\uFF57\uFF57.evil.com',
    'Voir //evil.example/x',
  ])('finds the web address in %j', (title) => {
    expect(found(with_((s) => Object.assign(s.seo.title, { en: title })))).toContain(
      'external_url@seo.title.en',
    );
  });

  it.each([
    'Salon à St. Barth',
    'St.Barth',
    'Coupe 12.50 €',
    'v1.2.3',
    'Voir le menu.pdf',
    'p.ex. une coupe',
    'J.-C. et Lun.-Ven.',
  ])('leaves ordinary text alone: %j', (title) => {
    expect(found(with_((s) => Object.assign(s.seo.title, { en: `${title} — Salon Lumière` })))).not.toContain(
      'external_url@seo.title.en',
    );
  });

  it('refuses hidden characters in the brand name and backslashes in URLs', () => {
    expect(found(with_((s) => Object.assign(s.brand, { name: 'Salon \u202eLumière' })))).toEqual([
      'schema@brand.name',
    ]);
    const slash = with_((s) =>
      Object.assign(s.contact, {
        socials: [
          { network: 'instagram', url: 'https://www.instagram.com\\.evil.com/x', factId: 'social.instagram' },
        ],
      }),
    );
    expect(found(slash)).toEqual(['schema@contact.socials.0.url']);
  });

  it('accepts only review pages on TripAdvisor', () => {
    const at = (url: string) =>
      with_((s) =>
        Object.assign(s.contact, { socials: [{ network: 'tripadvisor', url, factId: 'social.instagram' }] }),
      );
    expect(
      found(at('https://www.tripadvisor.fr/Restaurant_Review-g147339-d1234567-Reviews-Cafe-Saint_Jean.html')),
    ).toEqual([]);
    expect(found(at('https://www.tripadvisor.fr/ShowUrl-a_url.https%3A__2F__2Fevil.example.html'))).toContain(
      'social_host@contact.socials.0.url',
    );
  });

  it.each([
    'https://www.salon-lumiere.example/go?u=%5C%5Ce.com',
    'https://www.salon-lumiere.example/go?u=https:e.com',
    'https://www.salon-lumiere.example/go?next=evil.com',
    'https://www.salon-lumiere.example/go?u=ht%09tps://e.com',
    'https://www.salon-lumiere.example/go#u=https://e.com',
    'https://www.salon-lumiere.example/go#https://evil.xyz',
    'https://www.salon-lumiere.example/go?u=https://e.com#%',
    'https://www.salon-lumiere.example/go?u=93.184.216.34',
    'https://www.salon-lumiere.example/go#%ZZ%2F%2F93.184.216.34',
    'https://www.salon-lumiere.example/go#%E0%A4%A&u=https://evil.com',
  ])('refuses a url action that redirects: %s', (url) => {
    const spec = with_((s) => Object.assign(s.layout.header, { cta: { kind: 'url', label: L('Go'), url } }));
    expect(found(spec, { ...OPTIONS, ownDomains: ['salon-lumiere.example'] })).toContain(
      'external_url@layout.header.cta.url',
    );
  });

  it.each([
    'marie.le@salon.fr',
    'anne.ng@gmail.com',
    'contact.sb@orange.fr',
    'Email:anne.ng@gmail.com',
    'Courriel:contact.sb@orange.fr',
    'mailto:marie.le@salon.fr',
    'Mél:anne.ng@gmail.com',
    'Résa:contact.sb@orange.fr',
    'p.ex. une coupe et un brushing',
    'Salon St.Barth',
    'Chez M.Dupont',
    'S.A.R.L. au capital de 10 000 €',
    'Version 1.2.3, note 4.8/5',
    'Nos client·es sont ravi·es',
    'Nos client•es et ami‧es',
    'x </ y',
  ])('leaves %j alone', (title) => {
    expect(
      found(with_((s) => Object.assign(s.seo.title, { en: `${title} — Salon Lumière, Gustavia` }))),
    ).toEqual([]);
  });

  it.each([
    '//evil.com@a.bc',
    'ftp://evil.com@a.bc',
    'http:evil.com@a.bc',
    'http:mailto:evil.com@a.bc',
    'Follow us on x.com',
    'Join t.me/evil',
    'see m.evil.com',
    'see 3.evil.com',
    'see *.evil.com',
    'see _.evil.com',
    'see x_evil.com',
    'see ..evil.com',
    'Voir j.mp/promo',
    'Visitez evil.ovh',
    'Visitez evil.icu',
    'Visitez evil.ไทย',
    'Visitez evil.みんな',
    'Voir w.wiki/promo',
    'Voir x.cc',
    'Le Z.Bar',
    'Visitez évil.com',
    'see javascript:evil.com@a.bc',
    'evil・com',
    'evil･com',
    'evil⸱com',
    'Ｗｗｗ.evil.com@a.bc',
    'evil∙com',
    'evil•com',
    'see \\\\evil.com@a.bc',
    'see www.evil.com@a.bc',
    'evil·com',
    'evil.villas',
    'evil.рф',
    'evil.xn--p1ai',
    'Gustavia.Le port',
  ])(
    // The last one is meant: a missing space after a full stop reads as an address (the message says so).
    'finds the web address in %j',
    (title) => {
      expect(found(with_((s) => Object.assign(s.seo.title, { en: `${title} — Salon` })))).toContain(
        'external_url@seo.title.en',
      );
    },
  );

  it.each([
    'https://www.tripadvisor.fr/VacationRentalReview-g147339-d7654321-Villa_Les_Palmiers-Gustavia.html',
    'https://www.tripadvisor.com/AttractionProductReview-g147339-d11223344-Boat_Tour-Gustavia.html',
    'https://www.tripadvisor.fr/Restaurant_Review-g147339-d1234567-Reviews-Caf%C3%A9_Saint_Jean.html',
  ])('accepts the TripAdvisor page %s', (url) => {
    const spec = with_((s) =>
      Object.assign(s.contact, { socials: [{ network: 'tripadvisor', url, factId: 'social.instagram' }] }),
    );
    expect(found(spec)).toEqual([]);
  });

  it('validates a near-maximal hostile spec quickly (no quadratic pattern)', () => {
    const fillers = [
      'a'.repeat(4900),
      'a.'.repeat(2450),
      'a@'.repeat(2450),
      'a1.'.repeat(1633),
      'abc.'.repeat(1225),
      'aé.'.repeat(1633),
    ];
    const spec = with_((s) => {
      for (let n = 0; n < 5; n += 1) {
        s.pages.push({
          id: `extra-${n}`,
          slug: `extra-${n}`,
          title: L('Extra'),
          seo: {
            title: L('Extra page of the salon, Gustavia'),
            description: s.pages[0]?.seo.description ?? L('x'),
          },
          blocks: [
            { id: `hero-x${n}00`, type: 'hero', variant: 'minimal', props: { title: L('Extra') } },
            ...Array.from({ length: 19 }, (_, j) => ({
              id: `rich-x${n}${String(j).padStart(2, '0')}`,
              type: 'rich_text' as const,
              variant: 'narrow' as const,
              props: { body: L(fillers[j % fillers.length] ?? '') },
            })),
          ],
        });
      }
    });
    expect(parseSite(spec).spec).not.toBeNull();
    const started = performance.now();
    validateSite(spec, OPTIONS);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

import { BlockRenderer, blockTones, createRenderContext, SitePage, SkipLink } from '@bf/site-blocks';
import { type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import cafe from '@bf/site-schema/fixtures/cafe-saint-jean.json' with { type: 'json' };
import hardware from '@bf/site-schema/fixtures/hardware-store-lorient.json' with { type: 'json' };
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import villa from '@bf/site-schema/fixtures/villa-agency.json' with { type: 'json' };
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../../../i18n/messages/en.json';
import { SiteEditorProvider } from '../context.tsx';
import { CANVAS_OPTIONS, CanvasRoot } from './canvas.tsx';

// Canvas parity (BF-037): the editor's canvas composes a page exactly as the renderer's SitePage does — the same
// theme variables, banner, header, blocks with their tones, footer — for every fixture site, page and language.
// (The canvas leaves out the skip link only: it is the page's first focus stop, not part of the design.) The same
// stylesheet styles both (the block library's build, served at /_bf), so the same markup looks the same.

const FIXTURES = { cafe, hardware, salon, villa } as const;

describe('canvas parity with the renderer', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const spec = SiteSpecSchema.parse(fixture) as SiteSpec;
    for (const page of spec.pages) {
      for (const locale of spec.locales) {
        it(`${name} / ${page.id} / ${locale}`, () => {
          const ctx = createRenderContext(spec, page, locale, CANVAS_OPTIONS);
          const tones = blockTones(page.blocks);
          const canvas = renderToStaticMarkup(
            <NextIntlClientProvider locale="en" messages={en}>
              <SiteEditorProvider value={{ siteId: 's', spec, pageId: page.id, locale, readOnly: true }}>
                <CanvasRoot>
                  {page.blocks.map((block, index) => (
                    <BlockRenderer key={block.id} block={block} ctx={ctx} index={index} tone={tones[index]} />
                  ))}
                </CanvasRoot>
              </SiteEditorProvider>
            </NextIntlClientProvider>,
          );
          const site = renderToStaticMarkup(
            <SitePage spec={spec} page={page.id} locale={locale} {...CANVAS_OPTIONS} />,
          );
          const skip = renderToStaticMarkup(<SkipLink ctx={ctx} />);
          expect(canvas).toBe(site.replace(skip, ''));
        });
      }
    }
  }
});

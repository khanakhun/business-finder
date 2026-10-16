import { render } from '@testing-library/react';
import { build } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURES, fixture } from '../test-utils.tsx';

// Islands are the only client JavaScript of a site (BF-034): their props cross the server/client boundary (so they
// must survive JSON: no function, no class), and their bundles stay small (no schema, no zod).

const props = vi.hoisted(() => [] as { island: string; props: unknown }[]);
vi.mock('./open-now.tsx', () => ({
  OpenNow: (value: unknown) => {
    props.push({ island: 'OpenNow', props: value });
    return null;
  },
}));
vi.mock('./contact-form.tsx', () => ({
  ContactForm: (value: unknown) => {
    props.push({ island: 'ContactForm', props: value });
    return null;
  },
}));
vi.mock('./booking-embed.tsx', () => ({
  BookingEmbed: (value: unknown) => {
    props.push({ island: 'BookingEmbed', props: value });
    return null;
  },
}));

const { SitePage } = await import('../renderer/site-page.tsx');

describe('island props', () => {
  it('are plain data on every page of every fixture (and with an embeddable booking page)', () => {
    for (const name of FIXTURES) {
      const base = fixture(name);
      const spec =
        name === 'villa-agency'
          ? {
              ...base,
              contact: {
                ...base.contact,
                bookingUrl: { value: 'https://calendly.com/villas', factId: 'booking.main' },
              },
            }
          : base;
      for (const page of spec.pages)
        for (const locale of spec.locales) {
          const { unmount } = render(
            <SitePage spec={spec} page={page.id} locale={locale} contactFormAction="/api/forms/x" />,
          );
          unmount();
        }
    }
    expect(new Set(props.map((entry) => entry.island))).toEqual(
      new Set(['OpenNow', 'ContactForm', 'BookingEmbed']),
    );
    for (const entry of props) expect(JSON.parse(JSON.stringify(entry.props))).toEqual(entry.props);
  });
});

describe('island bundles', () => {
  it.each(['open-now.tsx', 'contact-form.tsx', 'booking-embed.tsx'])(
    '%s bundles without the schema, under 8 kB',
    async (file) => {
      const result = await build({
        entryPoints: [new URL(file, import.meta.url).pathname],
        bundle: true,
        minify: true,
        write: false,
        metafile: true,
        format: 'esm',
        platform: 'browser',
        external: ['react', 'react-dom', 'react/jsx-runtime'],
        jsx: 'automatic',
        logLevel: 'silent',
      });
      const inputs = Object.keys(result.metafile.inputs);
      expect(inputs.filter((input) => /zod|site-schema/.test(input))).toEqual([]);
      expect(result.outputFiles[0]?.contents.byteLength).toBeLessThan(8_000);
    },
  );
});

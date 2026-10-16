import type { SiteAsset, SiteAssetSources } from '@bf/contracts';
import { type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../../../i18n/messages/en.json';
import { type SiteEditorActions, SiteEditorActionsProvider, SiteEditorProvider } from '../context.tsx';
import { AssetPicker } from './asset-picker.tsx';

const api = vi.hoisted(() => ({
  fetchAssets: vi.fn(),
  uploadAsset: vi.fn(),
  fetchAssetSources: vi.fn(
    async (): Promise<SiteAssetSources> => ({ stock: [], ai: { enabled: false, remainingToday: 0 } }),
  ),
  searchStock: vi.fn(),
  importStock: vi.fn(),
  generateImages: vi.fn(),
}));
vi.mock('../api.ts', () => api);

const spec = SiteSpecSchema.parse(salon) as SiteSpec;

const library = (overrides: Partial<SiteAsset>): SiteAsset => ({
  id: '0199a0b0-0000-7000-8000-000000000001',
  siteId: null,
  status: 'ready',
  mime: 'image/jpeg',
  width: 1600,
  height: 1000,
  bytes: 1000,
  publicUrl: 'https://assets.sites.test/sites/s/a/1200.webp',
  variants: [],
  license: 'uploaded',
  licenseDetails: null,
  alt: { fr: 'La terrasse', en: 'The terrace' },
  dominantColors: null,
  kind: 'image',
  hosting: 'self',
  source: 'upload',
  restrictions: [],
  focalPoint: null,
  analysis: null,
  ownership: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

function renderPicker(onPick = vi.fn(), addAsset = vi.fn()) {
  const actions = { addAsset } as unknown as SiteEditorActions;
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SiteEditorProvider value={{ siteId: 'site-1', spec, pageId: 'home', locale: 'fr', readOnly: false }}>
        <SiteEditorActionsProvider value={actions}>
          <AssetPicker open onOpenChange={() => {}} onPick={onPick} />
        </SiteEditorActionsProvider>
      </SiteEditorProvider>
    </NextIntlClientProvider>,
  );
  return { onPick, addAsset };
}

afterEach(() => {
  api.fetchAssets.mockReset();
  api.uploadAsset.mockReset();
});

describe('AssetPicker', () => {
  it('requires a licence and the default language’s alt text before an upload', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    const submit = screen.getByRole('button', { name: 'Upload and use' });
    expect(submit).toHaveProperty('disabled', true);

    const file = new File([new Uint8Array(10)], 'terrace.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Image file'), file);
    await user.type(screen.getByLabelText('Alt text (FR) *'), 'La terrasse');
    // Without a licence the upload stays disabled.
    expect(submit).toHaveProperty('disabled', true);
    await user.selectOptions(screen.getByLabelText('Where does it come from? *'), 'uploaded');
    expect(submit).toHaveProperty('disabled', false);
    expect(api.uploadAsset).not.toHaveBeenCalled();
  });

  it('refuses another file type', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderPicker();
    await user.click(screen.getByRole('tab', { name: 'Upload' }));
    await user.upload(
      screen.getByLabelText('Image file'),
      new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
    );
    expect(screen.getByText('Choose a JPEG, PNG, WebP or AVIF image.')).toBeTruthy();
  });

  it('shows provider-restricted images without letting them be picked, and adds a library image to the site', async () => {
    api.fetchAssets.mockResolvedValue([
      library({ id: '0199a0b0-0000-7000-8000-00000000000a', licenseDetails: { provider: 'Google' } }),
      library({ id: '0199a0b0-0000-7000-8000-00000000000b', alt: { fr: 'Le salon' } }),
    ]);
    const user = userEvent.setup();
    const { onPick, addAsset } = renderPicker();
    await user.click(screen.getByRole('tab', { name: 'Library' }));
    await waitFor(() => expect(screen.getByText('Restricted by its provider')).toBeTruthy());
    const restricted = screen.getByText('Restricted by its provider').closest('button');
    expect(restricted).toHaveProperty('disabled', true);

    await user.click(screen.getByText('Le salon'));
    await user.click(screen.getByRole('button', { name: 'Use this image' }));
    expect(addAsset).toHaveBeenCalledTimes(1);
    const added = addAsset.mock.calls[0]?.[0] as { id: string; url: string; alt: unknown };
    expect(added.id).toMatch(/^img_[a-z0-9]{10}$/);
    expect(added.alt).toEqual({ fr: 'Le salon' });
    expect(onPick).toHaveBeenCalledWith(added.id);
  });

  it('offers stock photos when a provider is configured, and uses an imported one', async () => {
    api.fetchAssetSources.mockResolvedValueOnce({
      stock: ['unsplash'],
      ai: { enabled: false, remainingToday: 0 },
    });
    api.searchStock.mockResolvedValueOnce([
      {
        id: 'stock:unsplash:abc123',
        source: 'stock',
        assetId: null,
        previewUrl: 'https://images.unsplash.com/photo-abc?w=400',
        width: 2400,
        height: 1600,
        license: 'stock',
        attribution: 'Photo by Ana Ruiz on Unsplash',
        provider: 'unsplash',
        restrictions: [],
        alt: { en: 'turquoise sea' },
        score: 50,
        reasons: [],
      },
    ]);
    api.importStock.mockResolvedValueOnce(
      library({
        id: '0199a0b0-0000-7000-8000-0000000000cc',
        license: 'stock',
        source: 'stock',
        hosting: 'hotlink',
        publicUrl: 'https://images.unsplash.com/photo-abc?w=1200&ixid=x',
        licenseDetails: {
          attributionText: 'Photo by Ana Ruiz on Unsplash',
          authorUrl: 'https://unsplash.com/@ana',
        },
        alt: { fr: 'Mer turquoise' },
      }),
    );
    const user = userEvent.setup();
    const { onPick, addAsset } = renderPicker();
    await user.click(await screen.findByRole('tab', { name: 'Find more' }));
    await user.type(screen.getByLabelText('Search stock photos'), 'turquoise sea');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByText('Photo by Ana Ruiz on Unsplash'));
    await waitFor(() => expect(addAsset).toHaveBeenCalledTimes(1));
    const added = addAsset.mock.calls[0]?.[0] as {
      hosting?: string;
      attributionUrl?: string;
      license: string;
    };
    expect(added).toMatchObject({
      license: 'stock',
      hosting: 'hotlink',
      attributionUrl: 'https://unsplash.com/@ana',
    });
    expect(onPick).toHaveBeenCalled();
  });

  it('picks one of the site’s own images directly', async () => {
    const user = userEvent.setup();
    const { onPick, addAsset } = renderPicker();
    const [first] = spec.assets.filter((asset) => asset.kind === 'image');
    if (!first) throw new Error('the fixture has images');
    await user.click(screen.getByText(first.alt.fr ?? first.id));
    expect(onPick).toHaveBeenCalledWith(first.id);
    expect(addAsset).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import type { SiteSpec } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { referencedAssetUrls } from './render.ts';

// The assets a rendered site requests (BF-045): what the worker copies into the no-network quality sandbox.

const spec = JSON.parse(
  readFileSync(new URL('../../fixtures/workspace-salon/site.json', import.meta.url), 'utf8'),
) as SiteSpec;

describe('referencedAssetUrls', () => {
  it('lists every asset URL the pages request on our hosts, variants included, and nothing else', () => {
    const urls = referencedAssetUrls(spec, ['assets.bf-sites.test']);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(new URL(url).hostname).toBe('assets.bf-sites.test');
    for (const asset of spec.assets.filter((a) => a.url.includes('assets.bf-sites.test')))
      expect(urls.some((url) => url.startsWith(asset.url.replace(/\.[a-z]+$/, '')))).toBe(true);
    expect(referencedAssetUrls(spec, ['elsewhere.test'])).toEqual([]);
  });
});

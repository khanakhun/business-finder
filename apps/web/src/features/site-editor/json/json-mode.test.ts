import salon from '@bf/site-schema/fixtures/salon-gustavia.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { checkJson } from './json-mode.tsx';

const hosts = [new URL((salon.assets[0] as { url: string }).url).hostname];

describe('JSON mode checks', () => {
  it('tells unreadable JSON, a document the schema refuses and a valid site apart', () => {
    expect(checkJson('{ "version": ', hosts).state).toBe('syntax');
    const refused = checkJson(JSON.stringify({ ...salon, pages: [] }), hosts);
    expect(refused.state).toBe('invalid');
    if (refused.state === 'invalid') expect(refused.issues.length).toBeGreaterThan(0);
    const valid = checkJson(JSON.stringify(salon, null, 2), hosts);
    expect(valid.state).toBe('valid');
    if (valid.state === 'valid') {
      expect(valid.spec.brand.name).toBe(salon.brand.name);
      expect(valid.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('keeps a site with content errors savable, with its errors listed (publishing refuses them)', () => {
    const missing = structuredClone(salon) as unknown as { seo: { title: Partial<Record<string, string>> } };
    delete missing.seo.title.en;
    const checked = checkJson(JSON.stringify(missing), hosts);
    expect(checked.state).toBe('valid');
    if (checked.state === 'valid')
      expect(checked.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });
});

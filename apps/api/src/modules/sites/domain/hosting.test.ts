import { describe, expect, it } from 'vitest';
import { sitesShareCookieDomain } from './hosting.ts';

describe('sitesShareCookieDomain', () => {
  it.each([
    ['sites.example.com', 'example.com', true],
    ['sites.example.com', 'Example.COM.', true],
    ['sites.example.com', '.example.com', true],
    ['example.com', 'example.com', true],
    ['example-sites.com', 'example.com', false],
    ['sites.example.com', undefined, false],
    ['sites.example.com', '', false],
    ['notexample.com', 'example.com', false],
  ])('%s under %s → %s', (sites, cookie, shared) => {
    expect(sitesShareCookieDomain(sites, cookie)).toBe(shared);
  });
});

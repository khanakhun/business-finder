import { describe, expect, it } from 'vitest';
import { cleanHeaders } from './proxy-headers.ts';

describe('cleanHeaders', () => {
  it('drops every header the proxy owns, whatever a visitor sends', () => {
    const headers = cleanHeaders(
      new Headers({
        host: 'a.sites.example',
        'x-nonce': 'abc',
        'content-security-policy': "script-src 'unsafe-inline'",
        'x-bf-path': '/x',
        'x-bf-locale': 'en',
        'x-bf-anything': '1',
        accept: 'text/html',
      }),
    );
    expect([...headers.keys()].sort()).toEqual(['accept', 'host']);
  });
});

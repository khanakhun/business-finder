import { describe, expect, it, vi } from 'vitest';
import { cleanHeaders } from './proxy-headers.ts';
import { createTenantStore, type Tenant, TenantUnavailableError, withDeadline } from './tenant-store.ts';

vi.spyOn(console, 'log').mockImplementation(() => undefined);
vi.spyOn(console, 'error').mockImplementation(() => undefined);

const tenant = (overrides: Partial<Tenant> = {}): Tenant => ({
  hostname: 'a.sites.example',
  siteId: 'site-1',
  status: 'active',
  environment: 'preview',
  businessName: 'Salon',
  agencyName: 'Agence',
  agencyUrl: null,
  noindex: true,
  expiresAt: null,
  spec: null,
  images: {},
  ...overrides,
});

function harness(load: (hostname: string) => Promise<Tenant | null>) {
  let now = 1_000_000;
  const calls = vi.fn(load);
  const store = createTenantStore(calls, () => now);
  return { store, calls, advance: (ms: number) => (now += ms) };
}

describe('createTenantStore', () => {
  it('shares one lookup between concurrent requests, and caches it a minute', async () => {
    let release: (value: Tenant) => void = () => undefined;
    let first = true;
    const { store, calls, advance } = harness(() => {
      if (!first) return Promise.resolve(tenant());
      first = false;
      return new Promise((resolve) => (release = resolve));
    });
    const [a, b] = [store.get('a.sites.example'), store.get('a.sites.example')];
    release(tenant());
    expect(await a).toEqual(await b);
    expect(calls).toHaveBeenCalledTimes(1);
    advance(59_000);
    await store.get('a.sites.example');
    expect(calls).toHaveBeenCalledTimes(1);
    advance(2_000);
    await store.get('a.sites.example');
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('caches an unknown host briefly, and never a preview past its expiry', async () => {
    const { store, calls, advance } = harness(async (hostname) =>
      hostname === 'gone.sites.example'
        ? null
        : tenant({ expiresAt: new Date(1_000_000 + 5_000).toISOString() }),
    );
    expect(await store.get('gone.sites.example')).toBeNull();
    await store.get('a.sites.example');
    advance(6_000);
    await store.get('a.sites.example');
    // The preview expired after 5 s: looked up again (the view now says expired).
    expect(calls).toHaveBeenCalledTimes(3);
    advance(5_000);
    await store.get('gone.sites.example');
    expect(calls).toHaveBeenCalledTimes(4);
  });

  it('serves the last known site while the database is down, and answers at once during the down window', async () => {
    let down = false;
    const { store, calls, advance } = harness(async () => {
      if (down) throw new Error('connection refused');
      return tenant();
    });
    await store.get('a.sites.example');
    down = true;
    advance(61_000);
    expect(await store.get('a.sites.example')).toMatchObject({ siteId: 'site-1' });
    // Within the down window: no query at all.
    await expect(store.get('b.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    expect(calls).toHaveBeenCalledTimes(2);
    advance(6_000);
    await expect(store.get('b.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    expect(calls).toHaveBeenCalledTimes(3);
    // Past the grace (10 minutes): no last known site either.
    advance(11 * 60_000);
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
  });

  it('remembers an unrenderable site briefly instead of failing every request on the database', async () => {
    const { store, calls, advance } = harness(async () => {
      throw new TenantUnavailableError('newer schema');
    });
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    expect(calls).toHaveBeenCalledTimes(1);
    advance(31_000);
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('drops tagged entries on revalidation, and never keeps an answer that started before it', async () => {
    let release: (value: Tenant) => void = () => undefined;
    let answer = tenant();
    const { store, calls } = harness(() =>
      calls.mock.calls.length === 1 ? new Promise((resolve) => (release = resolve)) : Promise.resolve(answer),
    );
    const early = store.get('a.sites.example');
    answer = tenant({ status: 'unpublished' });
    expect(store.invalidate(['host:a.sites.example'])).toBe(0);
    release(tenant());
    expect(await early).toMatchObject({ status: 'active' });
    // Not kept: the next request reads the unpublished site.
    expect(await store.get('a.sites.example')).toMatchObject({ status: 'unpublished' });
    expect(store.invalidate(['site:site-1'])).toBe(1);
  });
});

describe('withDeadline', () => {
  it('fails a hanging lookup after its deadline', async () => {
    await expect(withDeadline(new Promise(() => undefined), 10)).rejects.toThrow(/timed out/);
    await expect(withDeadline(Promise.resolve(1), 10)).resolves.toBe(1);
  });
});

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

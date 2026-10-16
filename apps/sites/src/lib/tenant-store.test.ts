import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('never remembers a failure from before a revalidation', async () => {
    let reject: (error: Error) => void = () => undefined;
    const { store, calls } = harness(() =>
      calls.mock.calls.length === 1 ? new Promise((_, fail) => (reject = fail)) : Promise.resolve(tenant()),
    );
    const early = store.get('a.sites.example');
    // The API republishes a readable spec while the old lookup still reads the unreadable one.
    store.invalidate(['host:a.sites.example']);
    reject(new TenantUnavailableError('newer schema'));
    await expect(early).rejects.toBeInstanceOf(TenantUnavailableError);
    expect(await store.get('a.sites.example')).toMatchObject({ status: 'active' });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('forgets a remembered failure on revalidation', async () => {
    let broken = true;
    const { store, calls } = harness(async () => {
      if (broken) throw new TenantUnavailableError('newer schema');
      return tenant();
    });
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
    broken = false;
    store.invalidate(['host:a.sites.example']);
    expect(await store.get('a.sites.example')).toMatchObject({ status: 'active' });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('never serves an unpublished site during a later outage', async () => {
    let down = false;
    const { store, advance } = harness(async () => {
      if (down) throw new Error('connection refused');
      return tenant();
    });
    await store.get('a.sites.example');
    store.invalidate(['site:site-1']);
    down = true;
    advance(1_000);
    await expect(store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
  });

  it('never serves the last known preview past its expiry, even when the lookup hung until then', async () => {
    let hang = false;
    let advance: (ms: number) => number = () => 0;
    const harnessed = harness(async () => {
      if (!hang) return tenant({ expiresAt: new Date(1_000_000 + 63_000).toISOString() });
      // The lookup hangs past the preview's expiry before failing.
      advance(4_000);
      throw new Error('site lookup timed out');
    });
    advance = harnessed.advance;
    await harnessed.store.get('a.sites.example');
    hang = true;
    advance(61_000);
    await expect(harnessed.store.get('a.sites.example')).rejects.toBeInstanceOf(TenantUnavailableError);
  });

  it('serves known sites from memory during the down window, without a query', async () => {
    let down = false;
    const { store, calls, advance } = harness(async (hostname) => {
      if (down) throw new Error('connection refused');
      return tenant({ hostname });
    });
    await store.get('a.sites.example');
    await store.get('c.sites.example');
    down = true;
    advance(61_000);
    await expect(store.get('c.sites.example')).resolves.toMatchObject({ hostname: 'c.sites.example' });
    const queries = calls.mock.calls.length;
    await expect(store.get('a.sites.example')).resolves.toMatchObject({ hostname: 'a.sites.example' });
    expect(calls).toHaveBeenCalledTimes(queries);
  });

  it('keeps the answer of a lookup started after a revalidation, even when an older one settles last', async () => {
    const releases: Array<(value: Tenant) => void> = [];
    const { store, calls } = harness(() => new Promise((resolve) => releases.push(resolve)));
    const old = store.get('a.sites.example');
    store.invalidate(['host:a.sites.example']);
    const fresh = store.get('a.sites.example');
    expect(calls).toHaveBeenCalledTimes(2);
    releases[1]?.(tenant({ businessName: 'New' }));
    await fresh;
    releases[0]?.(tenant({ businessName: 'Old' }));
    await old;
    // The fresh answer is cached; the old lookup's end neither replaced it nor dropped it.
    expect(await store.get('a.sites.example')).toMatchObject({ businessName: 'New' });
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('shares the lookup started after a revalidation while an older one is still running', async () => {
    const releases: Array<(value: Tenant) => void> = [];
    const { store, calls } = harness(() => new Promise((resolve) => releases.push(resolve)));
    const old = store.get('a.sites.example');
    store.invalidate(['host:a.sites.example']);
    const fresh = store.get('a.sites.example');
    releases[0]?.(tenant({ businessName: 'Old' }));
    await old;
    // The old lookup's end must not drop the newer one in flight.
    const joined = store.get('a.sites.example');
    expect(calls).toHaveBeenCalledTimes(2);
    releases[1]?.(tenant({ businessName: 'New' }));
    expect(await joined).toMatchObject({ businessName: 'New' });
    await fresh;
  });
});

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a hanging lookup after its deadline', async () => {
    await expect(withDeadline(new Promise(() => undefined), 10)).rejects.toThrow(/timed out/);
    await expect(withDeadline(Promise.resolve(1), 10)).resolves.toBe(1);
  });

  it('leaves no timer behind, whether the lookup succeeds or fails', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(1), 1_000)).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(withDeadline(Promise.reject(new Error('refused')), 1_000)).rejects.toThrow('refused');
    expect(vi.getTimerCount()).toBe(0);
  });
});

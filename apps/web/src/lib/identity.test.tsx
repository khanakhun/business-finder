import { ApiError } from '@bf/api-client';
import type { Me } from '@bf/contracts';
import { render, renderHook, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useErrorMessage } from '../components/auth/fields.tsx';
import { WorkspaceGate } from '../components/shell/workspace-gate.tsx';
import en from '../i18n/messages/en.json';
import { authClient, unwrap } from './auth-client.ts';
import { safeNext } from './safe-next.ts';
import { SessionProvider, usePermission, useSession } from './session.tsx';

const path = vi.hoisted(() => ({ current: '/search' }));
vi.mock('next/navigation', () => ({ usePathname: () => path.current }));

const me: Me = {
  user: {
    id: '01a13c00-0000-7000-8000-000000000001',
    name: 'Ana',
    email: 'ana@example.test',
    emailVerified: true,
    image: null,
    locale: 'en',
    twoFactorEnabled: false,
  },
  activeOrganization: {
    id: '01a13c00-0000-7000-8000-000000000002',
    name: 'Agence',
    slug: 'agence',
    role: 'member',
  },
  role: 'member',
  permissions: ['business:read', 'business:write'],
  organizations: [],
};

describe('safeNext (open-redirect guard)', () => {
  it.each([
    ['/search?q=1', '/search?q=1'],
    ['/invite/abc', '/invite/abc'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['/\n/evil.example', '/'],
    ['/\r/evil.example', '/'],
    ['/%09/evil.example', '/%09/evil.example'],
    ['/a\\b', '/'],
    ['/settings/../search', '/search'],
    ['/search#results', '/search#results'],
    ['https://evil.example', '/'],
    ['', '/'],
    [null, '/'],
    [undefined, '/'],
  ])('%j → %s', (value, expected) => {
    expect(safeNext(value)).toBe(expected);
  });
});

describe('session context', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionProvider me={me}>{children}</SessionProvider>
  );

  it('answers permissions of the active workspace', () => {
    const { result } = renderHook(() => [usePermission('business:write'), usePermission('members:manage')], {
      wrapper,
    });
    expect(result.current).toEqual([true, false]);
  });

  it('throws outside the dashboard', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderHook(() => useSession())).toThrow(/SessionProvider/);
  });

  it('renders the user from the provider', () => {
    function Name() {
      return <p>{useSession().user.name}</p>;
    }
    render(<Name />, { wrapper });
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });
});

describe('auth client helpers', () => {
  it('unwrap returns data and turns errors into exceptions carrying the code and status', async () => {
    await expect(unwrap(Promise.resolve({ data: { ok: true }, error: null }))).resolves.toEqual({ ok: true });
    await expect(
      unwrap(Promise.resolve({ data: null, error: { message: 'nope', code: 'INVALID_CODE', status: 401 } })),
    ).rejects.toMatchObject({ message: 'nope', code: 'INVALID_CODE', status: 401 });
  });

  it('creates one client per tab', () => {
    expect(authClient()).toBe(authClient());
  });
});

describe('useErrorMessage', () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );

  it('maps known codes, rate limits and unknown errors', () => {
    const { result } = renderHook(() => useErrorMessage(), { wrapper });
    expect(result.current({ code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('Wrong email or password.');
    expect(result.current({ status: 429 })).toMatch(/Too many attempts/);
    expect(result.current(new Error('boom'))).toBe('Something went wrong. Please try again.');
    expect(result.current(null)).toBe('Something went wrong. Please try again.');
  });

  it('prefers the API problem reason, then its code', () => {
    const { result } = renderHook(() => useErrorMessage(), { wrapper });
    const problem = { type: 'about:blank', title: 'Conflict', status: 409, code: 'CONFLICT' };
    expect(result.current(new ApiError({ ...problem, reason: 'LAST_OWNER' }))).toMatch(/at least one owner/);
    expect(result.current(new ApiError({ ...problem, status: 403, code: 'FORBIDDEN' }))).toMatch(
      /permission/,
    );
    expect(result.current(new ApiError(problem))).toBe('Something went wrong. Please try again.');
  });
});

describe('WorkspaceGate', () => {
  const renderGate = (session: Me) =>
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <SessionProvider me={session}>
          <WorkspaceGate>
            <p>page</p>
          </WorkspaceGate>
        </SessionProvider>
      </NextIntlClientProvider>,
    );
  const noWorkspace: Me = { ...me, activeOrganization: null, role: null, permissions: [], organizations: [] };

  it('shows the page with an active workspace', () => {
    renderGate(me);
    expect(screen.getByText('page')).toBeInTheDocument();
  });

  it('explains instead when there is none, except on workspace-free pages (read on every navigation)', () => {
    const { unmount } = renderGate(noWorkspace);
    expect(screen.queryByText('page')).not.toBeInTheDocument();
    expect(screen.getByText(en.workspace.noneTitle)).toBeInTheDocument();
    unmount();
    path.current = '/settings/account';
    renderGate(noWorkspace);
    expect(screen.getByText('page')).toBeInTheDocument();
  });
});

describe('server session', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load(cookie: string | null, response: Response) {
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/headers', () => ({ headers: async () => new Headers(cookie ? { cookie } : {}) }));
    const fetch = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetch);
    return { module: await import('./server-session.ts'), fetch };
  }

  it('is signed out without cookies, without calling the API', async () => {
    const { module, fetch } = await load(null, new Response());
    await expect(module.getSession()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards cookies to GET /v1/me and maps 401 to signed out', async () => {
    const ok = await load('bf.session_token=x', Response.json(me));
    await expect(ok.module.getSession()).resolves.toEqual(me);
    expect(ok.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/me$/),
      expect.objectContaining({ headers: { cookie: 'bf.session_token=x' } }),
    );

    const signedOut = await load('bf.session_token=old', new Response(null, { status: 401 }));
    await expect(signedOut.module.getSession()).resolves.toBeNull();

    const broken = await load('bf.session_token=x', new Response(null, { status: 503 }));
    await expect(broken.module.getSession()).rejects.toThrow(/503/);
  });

  it('reads the public identity config', async () => {
    const config = { signupMode: 'invite_only', googleEnabled: false, minPasswordLength: 12 };
    const { module } = await load(null, Response.json(config));
    await expect(module.getIdentityConfig()).resolves.toEqual(config);
  });
});

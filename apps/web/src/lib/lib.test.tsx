import { act, render, screen } from '@testing-library/react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { negotiateLocale } from '../i18n/locales.ts';
import { buildCsp } from '../proxy.ts';
import {
  type Command,
  CommandRegistryProvider,
  useCommandRegistry,
  useRegisterCommands,
} from './commands.tsx';
import { isModKey, isTypingTarget } from './keyboard.ts';
import { activeNavItem, NAV_ITEMS } from './navigation.ts';

describe('activeNavItem', () => {
  it.each([
    ['/', 'home'],
    ['/search', 'search'],
    ['/outreach/inbox', 'inbox'],
    ['/outreach/inbox/thread-1', 'inbox'],
    ['/settings', 'settings'],
    ['/searching', undefined],
  ])('%s → %s', (path, key) => {
    expect(activeNavItem(path)?.key).toBe(key);
  });

  it('has unique keys and hrefs', () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
  });
});

describe('negotiateLocale', () => {
  it.each([
    ['fr-FR,fr;q=0.9,en;q=0.8', 'fr'],
    ['de-DE,en;q=0.5', 'en'],
    ['', 'en'],
    [null, 'en'],
  ])('%j → %s', (header, locale) => {
    expect(negotiateLocale(header)).toBe(locale);
  });
});

describe('buildCsp', () => {
  const csp = buildCsp('abc123', { dev: false, apiOrigin: 'https://api.example', https: true });

  it('uses the nonce for scripts, never unsafe-inline scripts', () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src https://api.example'.replace('connect-src ', "connect-src 'self' "));
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('allows eval and websockets only in development, and skips upgrades over http', () => {
    const dev = buildCsp('n', { dev: true, apiOrigin: 'http://localhost:4000', https: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
    expect(dev).not.toContain('upgrade-insecure-requests');
    expect(csp).not.toContain("'unsafe-eval'");
  });
});

describe('keyboard helpers', () => {
  it('detects typing targets and the mod key', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
    expect(isModKey(new KeyboardEvent('keydown', { metaKey: true }))).toBe(true);
    expect(isModKey(new KeyboardEvent('keydown', { ctrlKey: true }))).toBe(true);
    expect(isModKey(new KeyboardEvent('keydown', {}))).toBe(false);
  });
});

describe('command registry', () => {
  const command = (id: string): Command => ({ id, label: id, group: 'g', run: vi.fn() });

  function Feature({ commands }: { commands: Command[] }) {
    useRegisterCommands(commands);
    return null;
  }
  function List() {
    const { commands } = useCommandRegistry();
    return <p data-testid="ids">{commands.map((c) => c.id).join(',')}</p>;
  }

  it('collects commands from mounted features and drops them on unmount', () => {
    const a = [command('a')];
    const b = [command('b')];
    const { rerender } = render(
      <CommandRegistryProvider>
        <Feature commands={a} />
        <Feature commands={b} />
        <List />
      </CommandRegistryProvider>,
    );
    expect(screen.getByTestId('ids')).toHaveTextContent('a,b');
    rerender(
      <CommandRegistryProvider>
        <Feature commands={a} />
        <List />
      </CommandRegistryProvider>,
    );
    expect(screen.getByTestId('ids')).toHaveTextContent(/^a$/);
  });

  it('replaces a command registered again with the same id', () => {
    const first = [command('same')];
    const second = [{ ...command('same'), label: 'second' }];
    render(
      <CommandRegistryProvider>
        <Feature commands={first} />
        <Feature commands={second} />
        <List />
      </CommandRegistryProvider>,
    );
    expect(screen.getByTestId('ids')).toHaveTextContent(/^same$/);
  });

  it('requires the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => act(() => void render(<List />))).toThrow(/CommandRegistryProvider/);
  });
});

describe('shell command registration', () => {
  it('settles: a stable command list does not re-register on every render', async () => {
    let renders = 0;
    function Feature() {
      renders++;
      const commands = React.useMemo(() => [{ id: 'x', label: 'x', group: 'g', run: () => undefined }], []);
      useRegisterCommands(commands);
      return null;
    }
    render(
      <CommandRegistryProvider>
        <Feature />
      </CommandRegistryProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renders).toBeLessThan(5);
  });
});

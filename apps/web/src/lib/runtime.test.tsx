import { render } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { PageSkeleton } from '../components/states/page-skeleton.tsx';
import { proxy } from '../proxy.ts';
import { apiClient, queryKeys } from './api.ts';

describe('proxy', () => {
  it('sets a fresh nonce-based CSP on the response and forwards the nonce to rendering', () => {
    const first = proxy(new NextRequest('http://localhost:3000/'));
    const second = proxy(new NextRequest('http://localhost:3000/'));
    const csp = first.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(second.headers.get('content-security-policy')).not.toContain(`nonce-${nonce}`);
    // Request headers forwarded to Next.js are exposed as x-middleware-request-* on the response.
    expect(first.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
  });
});

describe('api client', () => {
  it('is a single client per tab with stable query keys', () => {
    expect(apiClient()).toBe(apiClient());
    expect(queryKeys.system.info()).toEqual(['system', 'info']);
    expect(queryKeys.system.all).toEqual(['system']);
    expect(queryKeys.taxonomy.tree('fr')).toEqual(['taxonomy', 'tree', 'fr']);
    expect(queryKeys.discovery.providers()).toEqual(['discovery', 'providers']);
    expect(queryKeys.discovery.scraper()).toEqual(['discovery', 'scraper']);
    // Every business query starts with ['business', id]: one invalidation refreshes the whole page (BF-024).
    const id = 'b1';
    for (const key of [
      queryKeys.business.detail(id),
      queryKeys.business.crm(id),
      queryKeys.business.contacts(id),
      queryKeys.business.notes(id),
      queryKeys.business.tasks(id),
      queryKeys.business.activities(id),
      queryKeys.business.duplicates(id),
    ])
      expect(key.slice(0, 2)).toEqual(['business', id]);
    expect(queryKeys.identity.teammates()).toEqual(['identity', 'teammates']);
    expect(queryKeys.crm.board({ owner: 'me' })).toEqual(['crm', 'board', { owner: 'me' }]);
    expect(queryKeys.crm.tasks({ due: 'today' })).toEqual(['crm', 'tasks', { due: 'today' }]);
    expect(queryKeys.search.lists()).toEqual(['search', 'lists']);
    expect(queryKeys.workspace.settings()).toEqual(['workspace', 'settings']);
    expect(queryKeys.taxonomy.mappings('needs_review', 'en')).toEqual([
      'taxonomy',
      'mappings',
      'needs_review',
      'en',
    ]);
  });
});

describe('PageSkeleton', () => {
  it('marks the region as busy', () => {
    const { container } = render(<PageSkeleton />);
    expect(container.firstElementChild).toHaveAttribute('aria-busy', 'true');
  });
});

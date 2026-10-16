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

'use client';

import { type ApiClient, createApiClient, defineQueryKeys } from '@bf/api-client';

let client: ApiClient | undefined;

/** The browser's API client (one per tab). Base URL is inlined at build time from NEXT_PUBLIC_API_URL. */
export function apiClient(): ApiClient {
  client ??= createApiClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000' });
  return client;
}

/** Every query key in the dashboard, in one place (coding-standards §3). */
export const queryKeys = {
  system: defineQueryKeys('system', { info: () => ['system', 'info'] as const }),
  identity: defineQueryKeys('identity', {
    members: () => ['identity', 'members'] as const,
    teammates: () => ['identity', 'teammates'] as const,
    apiKeys: () => ['identity', 'api-keys'] as const,
    sessions: () => ['identity', 'sessions'] as const,
  }),
  notifications: defineQueryKeys('notifications', {
    unread: () => ['notifications', 'unread'] as const,
    recent: () => ['notifications', 'recent'] as const,
    list: (filter: 'all' | 'unread') => ['notifications', 'list', filter] as const,
    preferences: () => ['notifications', 'preferences'] as const,
  }),
  taxonomy: defineQueryKeys('taxonomy', {
    tree: (locale: string) => ['taxonomy', 'tree', locale] as const,
    mappings: (status: string, locale: string) => ['taxonomy', 'mappings', status, locale] as const,
  }),
  discovery: defineQueryKeys('discovery', {
    providers: () => ['discovery', 'providers'] as const,
    scraper: () => ['discovery', 'scraper'] as const,
    run: (id: string) => ['discovery', 'run', id] as const,
  }),
  search: defineQueryKeys('search', {
    listing: (query: Readonly<Record<string, string | string[]>>) => ['search', 'listing', query] as const,
    facets: (query: Readonly<Record<string, string | string[]>>) => ['search', 'facets', query] as const,
    saved: () => ['search', 'saved'] as const,
    lists: () => ['search', 'lists'] as const,
    list: (id: string) => ['search', 'list', id] as const,
  }),
  business: defineQueryKeys('business', {
    detail: (id: string) => ['business', id, 'detail'] as const,
    crm: (id: string) => ['business', id, 'crm'] as const,
    contacts: (id: string) => ['business', id, 'contacts'] as const,
    notes: (id: string) => ['business', id, 'notes'] as const,
    tasks: (id: string) => ['business', id, 'tasks'] as const,
    activities: (id: string) => ['business', id, 'activities'] as const,
    duplicates: (id: string) => ['business', id, 'duplicates'] as const,
  }),
  crm: defineQueryKeys('crm', {
    board: (filters: Readonly<Record<string, string>>) => ['crm', 'board', filters] as const,
    tasks: (filters: Readonly<Record<string, string>>) => ['crm', 'tasks', filters] as const,
  }),
  workspace: defineQueryKeys('workspace', {
    settings: () => ['workspace', 'settings'] as const,
    logo: () => ['workspace', 'logo'] as const,
    secrets: () => ['workspace', 'secrets'] as const,
    audit: (filters: Readonly<Record<string, string>>) => ['workspace', 'audit', filters] as const,
  }),
};

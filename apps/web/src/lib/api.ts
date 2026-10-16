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
  }),
  workspace: defineQueryKeys('workspace', {
    settings: () => ['workspace', 'settings'] as const,
    logo: () => ['workspace', 'logo'] as const,
    secrets: () => ['workspace', 'secrets'] as const,
    audit: (filters: Readonly<Record<string, string>>) => ['workspace', 'audit', filters] as const,
  }),
};

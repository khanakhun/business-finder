'use client';

import { type ApiClient, createApiClient, defineQueryKeys } from '@bf/api-client';
import { publicEnv } from './public-env.ts';

let client: ApiClient | undefined;

/** The browser's API client (one per tab), on the deployment's API URL (`publicEnv`, read at run time). */
export function apiClient(): ApiClient {
  client ??= createApiClient({ baseUrl: publicEnv().apiUrl });
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
  reviews: defineQueryKeys('reviews', {
    sources: () => ['reviews', 'sources'] as const,
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
    enrichment: (id: string) => ['business', id, 'enrichment'] as const,
    website: (id: string) => ['business', id, 'website'] as const,
    websiteAudit: (id: string) => ['business', id, 'website-audit'] as const,
    reviews: (id: string) => ['business', id, 'reviews'] as const,
    scores: (id: string) => ['business', id, 'scores'] as const,
  }),
  scoring: defineQueryKeys('scoring', {
    profiles: () => ['scoring', 'profiles'] as const,
    versions: (profileId: string) => ['scoring', 'versions', profileId] as const,
    version: (profileId: string, version: number) => ['scoring', 'version', profileId, version] as const,
    sample: (profileId: string) => ['scoring', 'sample', profileId] as const,
  }),
  crm: defineQueryKeys('crm', {
    board: (filters: Readonly<Record<string, string>>) => ['crm', 'board', filters] as const,
    tasks: (filters: Readonly<Record<string, string>>) => ['crm', 'tasks', filters] as const,
  }),
  generation: defineQueryKeys('generation', {
    engines: () => ['generation', 'engines'] as const,
    batches: (filters: Readonly<Record<string, string>>) => ['generation', 'batches', filters] as const,
    batch: (id: string) => ['generation', 'batch', id] as const,
    job: (id: string) => ['generation', 'job', id] as const,
    brief: (businessId: string) => ['generation', 'brief', businessId] as const,
    quality: (jobId: string) => ['generation', 'quality', jobId] as const,
    selection: (ids: readonly string[]) => ['generation', 'selection', ids] as const,
    businessSite: (businessId: string) => ['generation', 'business-site', businessId] as const,
    jobs: (filters: Readonly<Record<string, string>>) => ['generation', 'jobs', filters] as const,
    workspace: (jobId: string) => ['generation', 'workspace', jobId] as const,
    artifacts: (jobId: string) => ['generation', 'artifacts', jobId] as const,
    settings: () => ['generation', 'settings'] as const,
  }),
  leads: defineQueryKeys('leads', {
    list: (filters: Readonly<Record<string, string>>) => ['leads', 'list', filters] as const,
    detail: (id: string) => ['leads', 'detail', id] as const,
    counts: () => ['leads', 'counts'] as const,
  }),
  mailboxes: defineQueryKeys('mailboxes', {
    list: () => ['mailboxes', 'list'] as const,
    detail: (id: string) => ['mailboxes', 'detail', id] as const,
    providers: () => ['mailboxes', 'providers'] as const,
  }),
  compliance: defineQueryKeys('compliance', {
    policies: () => ['compliance', 'policies'] as const,
    versions: (jurisdiction: string, channel: string) =>
      ['compliance', 'versions', jurisdiction, channel] as const,
    lawfulBasis: () => ['compliance', 'lawful-basis'] as const,
    evaluation: (businessId: string, channel: string, purpose: string) =>
      ['compliance', 'evaluation', businessId, channel, purpose] as const,
    decisions: (businessId: string) => ['compliance', 'decisions', businessId] as const,
  }),
  workspace: defineQueryKeys('workspace', {
    settings: () => ['workspace', 'settings'] as const,
    logo: () => ['workspace', 'logo'] as const,
    secrets: () => ['workspace', 'secrets'] as const,
    audit: (filters: Readonly<Record<string, string>>) => ['workspace', 'audit', filters] as const,
  }),
};

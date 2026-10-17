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
  scoringMl: defineQueryKeys('scoring-ml', {
    readiness: (offer: string) => ['scoring-ml', 'readiness', offer] as const,
    datasets: () => ['scoring-ml', 'datasets'] as const,
    runs: () => ['scoring-ml', 'runs'] as const,
    models: () => ['scoring-ml', 'models'] as const,
    importance: (id: string) => ['scoring-ml', 'importance', id] as const,
    shadow: () => ['scoring-ml', 'shadow'] as const,
    comparison: (profileId: string) => ['scoring-ml', 'comparison', profileId] as const,
    promotions: () => ['scoring-ml', 'promotions'] as const,
    monitoring: (id: string) => ['scoring-ml', 'monitoring', id] as const,
    businessShadow: (businessId: string) => ['scoring-ml', 'business-shadow', businessId] as const,
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
  outreach: defineQueryKeys('outreach', {
    drafts: (businessId: string) => ['outreach', 'drafts', businessId] as const,
    draft: (id: string) => ['outreach', 'draft', id] as const,
    preview: (id: string, updatedAt: string) => ['outreach', 'preview', id, updatedAt] as const,
    templates: (archived: boolean) => ['outreach', 'templates', archived] as const,
    templateVersions: (id: string) => ['outreach', 'template-versions', id] as const,
    // BF-052: the outbox, one message, a business's history, bulk runs.
    messages: (filters: Record<string, string>) => ['outreach', 'messages', filters] as const,
    message: (id: string) => ['outreach', 'message', id] as const,
    history: (businessId: string) => ['outreach', 'history', businessId] as const,
    bulkRuns: () => ['outreach', 'bulk-runs'] as const,
    bulkRun: (id: string) => ['outreach', 'bulk-run', id] as const,
  }),
  analytics: defineQueryKeys('analytics', {
    registry: () => ['analytics', 'registry'] as const,
    query: (query: unknown) => ['analytics', 'query', query] as const,
    funnel: (query: unknown) => ['analytics', 'funnel', query] as const,
    cohorts: (query: unknown) => ['analytics', 'cohorts', query] as const,
    trends: (query: unknown) => ['analytics', 'trends', query] as const,
  }),
  assist: defineQueryKeys('assist', {
    workspace: (businessId: string) => ['assist', 'workspace', businessId] as const,
    script: (businessId: string, offer: string, locale: string) =>
      ['assist', 'script', businessId, offer, locale] as const,
    calls: () => ['assist', 'calls'] as const,
  }),
  deliverability: defineQueryKeys('deliverability', {
    overview: () => ['deliverability', 'overview'] as const,
    readiness: () => ['deliverability', 'readiness'] as const,
    health: () => ['deliverability', 'health'] as const,
  }),
  sequences: defineQueryKeys('sequences', {
    list: () => ['sequences', 'list'] as const,
    stats: (id: string) => ['sequences', 'stats', id] as const,
    enrollments: (businessId: string) => ['sequences', 'enrollments', businessId] as const,
  }),
  inbox: defineQueryKeys('inbox', {
    list: (filters: Record<string, string>) => ['inbox', 'list', filters] as const,
    thread: (id: string) => ['inbox', 'thread', id] as const,
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
    evaluation: (businessId: string, channel: string, purpose: string, contactId?: string) =>
      ['compliance', 'evaluation', businessId, channel, purpose, contactId ?? null] as const,
    decisions: (businessId: string) => ['compliance', 'decisions', businessId] as const,
    suppressions: (filters: Record<string, string | undefined>) =>
      ['compliance', 'suppressions', filters] as const,
    requests: () => ['compliance', 'requests'] as const,
    request: (id: string) => ['compliance', 'requests', id] as const,
    retention: () => ['compliance', 'retention'] as const,
  }),
  workspace: defineQueryKeys('workspace', {
    settings: () => ['workspace', 'settings'] as const,
    logo: () => ['workspace', 'logo'] as const,
    secrets: () => ['workspace', 'secrets'] as const,
    audit: (filters: Readonly<Record<string, string>>) => ['workspace', 'audit', filters] as const,
  }),
};

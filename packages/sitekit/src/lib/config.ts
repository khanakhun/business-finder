import { HOTLINK_HOSTS, SITE_LOCALES } from '@bf/site-schema';
import { z } from 'zod';
import type { Workspace } from './workspace.ts';

// `.sitekit.json` (written by the workspace builder, BF-040): locales, strict facts, tighter limits, lint severities
// and the hosts the validator accepts. Missing file → defaults; invalid file → an error naming the field.

export const CONFIG_FILE = '.sitekit.json';

export const DEFAULT_LIMITS = { pages: 8, blocksPerPage: 20, specBytes: 1_000_000 } as const;

const host = z.string().regex(/^[a-z0-9.-]{1,253}$/i);

export const SitekitConfigSchema = z
  .object({
    locales: z.array(z.enum(SITE_LOCALES)).min(1).max(4).optional(),
    defaultLocale: z.enum(SITE_LOCALES).optional(),
    strictFacts: z.boolean().default(true),
    /** Overrides may only tighten the defaults. */
    limits: z
      .object({
        pages: z.number().int().min(1).max(DEFAULT_LIMITS.pages).optional(),
        blocksPerPage: z.number().int().min(1).max(DEFAULT_LIMITS.blocksPerPage).optional(),
        specBytes: z.number().int().min(1024).max(DEFAULT_LIMITS.specBytes).optional(),
      })
      .default({}),
    /** Lint rule id → severity (severity only; rules stay as data). */
    lint: z
      .record(z.string().regex(/^[a-z][a-z0-9_.-]{1,60}$/), z.enum(['error', 'warning', 'off']))
      .default({}),
    /** Hosts images may come from (our storage/CDN), stock CDNs images may be hotlinked from, the business's domains. */
    assetHosts: z.array(host).max(20).default([]),
    hotlinkHosts: z
      .array(host)
      .max(20)
      .default([...HOTLINK_HOSTS]),
    ownDomains: z.array(host).max(20).default([]),
    /** What the builder noticed (not rules). */
    warnings: z.array(z.string().max(300)).max(50).default([]),
  })
  .passthrough();
export type SitekitConfig = z.infer<typeof SitekitConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export async function loadConfig(workspace: Workspace): Promise<SitekitConfig> {
  if (!(await workspace.exists(CONFIG_FILE))) return SitekitConfigSchema.parse({});
  const parsed = SitekitConfigSchema.safeParse(await workspace.readJson(CONFIG_FILE, 64 * 1024));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(
      `${CONFIG_FILE}: ${first ? `${first.path.join('.') || '(root)'} — ${first.message}` : 'invalid'}.`,
    );
  }
  return parsed.data;
}

export const limitsOf = (config: SitekitConfig) => ({
  pages: config.limits.pages ?? DEFAULT_LIMITS.pages,
  blocksPerPage: config.limits.blocksPerPage ?? DEFAULT_LIMITS.blocksPerPage,
  specBytes: config.limits.specBytes ?? DEFAULT_LIMITS.specBytes,
});

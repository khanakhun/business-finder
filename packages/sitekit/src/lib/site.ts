import type { SiteSpec } from '@bf/site-schema';
import { parseSite } from '@bf/site-schema';
import { limitsOf, type SitekitConfig } from './config.ts';
import type { Workspace } from './workspace.ts';

// site.json in the workspace (BF-042): read raw (validation reports what is wrong with it), within its size limit.

export const SITE_FILE = 'site.json';

export async function readSiteRaw(
  workspace: Workspace,
  config: SitekitConfig,
): Promise<{ readonly value: unknown; readonly bytes: number }> {
  const text = await workspace.readText(SITE_FILE, limitsOf(config).specBytes * 2);
  return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

/** The spec when it parses (the validator explains why when it does not). */
export function asSpec(value: unknown): SiteSpec | undefined {
  return parseSite(value).spec ?? undefined;
}

export async function writeSite(workspace: Workspace, spec: SiteSpec): Promise<void> {
  await workspace.writeText(SITE_FILE, `${JSON.stringify(spec, null, 2)}\n`);
}

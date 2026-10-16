import type { SiteSpec } from '@bf/site-schema';
import { loadConfig } from './config.ts';
import { lintCopy } from './lint.ts';
import { readFacts } from './readers.ts';
import { RENDER_DIR, renderSite } from './render.ts';
import { type Shooter, type Shot, screenshot } from './screenshot.ts';
import { asSpec, readSiteRaw } from './site.ts';
import { validate } from './validate.ts';
import type { Workspace } from './workspace.ts';

// check (BF-042): the definition of done for a generated site — zero validation errors (strict facts), zero copy
// errors, every page renders in every locale, the home page photographed on mobile and desktop, limits held.

export const SHOTS_DIR = '.sitekit/screenshots';

export interface CheckItem {
  readonly kind: 'validate' | 'lint' | 'render' | 'screenshot' | 'workspace';
  readonly at?: string;
  readonly message: string;
  readonly hint?: string;
}

export interface CheckReport {
  readonly done: boolean;
  readonly blocking: CheckItem[];
  readonly warnings: CheckItem[];
  readonly counts: {
    readonly validationErrors: number;
    readonly lintErrors: number;
    readonly pagesRendered: number;
    readonly screenshots: number;
  };
  readonly screenshots: Shot[];
  readonly durationMs: number;
}

export async function check(
  workspace: Workspace,
  options: { shooter?: Shooter; css?: string; now?: () => number } = {},
): Promise<CheckReport> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const blocking: CheckItem[] = [];
  const warnings: CheckItem[] = [];
  const counts = { validationErrors: 0, lintErrors: 0, pagesRendered: 0, screenshots: 0 };
  const report = (screenshots: Shot[] = []): CheckReport => ({
    done: blocking.length === 0,
    blocking,
    warnings,
    counts,
    screenshots,
    durationMs: Math.round(now() - started),
  });

  let config: Awaited<ReturnType<typeof loadConfig>>;
  let raw: { value: unknown; bytes: number };
  try {
    config = await loadConfig(workspace);
    raw = await readSiteRaw(workspace, config);
  } catch (error) {
    blocking.push({ kind: 'workspace', message: error instanceof Error ? error.message : String(error) });
    return report();
  }
  const facts = await readFacts(workspace).catch((error: unknown) => {
    blocking.push({
      kind: 'workspace',
      message: `facts.json: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  });
  for (const issue of validate(raw.value, { config, bytes: raw.bytes, ...(facts ? { facts } : {}) })) {
    const item = { kind: 'validate' as const, at: issue.at, message: issue.message, hint: issue.hint };
    if (issue.severity === 'error') {
      counts.validationErrors++;
      blocking.push(item);
    } else warnings.push(item);
  }
  const spec: SiteSpec | undefined = asSpec(raw.value);
  if (!spec) return report();
  for (const issue of lintCopy(spec, { config, ...(facts ? { facts } : {}) })) {
    const item = {
      kind: 'lint' as const,
      at: issue.at,
      message: `${issue.rule}: ${issue.message}`,
      hint: issue.hint,
    };
    if (issue.severity === 'error') {
      counts.lintErrors++;
      blocking.push(item);
    } else warnings.push(item);
  }
  try {
    const rendered = await renderSite(workspace, spec, { ...(options.css ? { css: options.css } : {}) });
    counts.pagesRendered = rendered.pages.length;
    if (!rendered.fonts)
      warnings.push({
        kind: 'render',
        message: 'The block fonts are not built: screenshots use fallback fonts.',
      });
  } catch (error) {
    blocking.push({
      kind: 'render',
      message: `The site does not render: ${error instanceof Error ? error.message : String(error)}`,
    });
    return report();
  }
  const home = spec.pages.find((page) => page.slug === '') ?? spec.pages[0];
  if (!home) return report();
  try {
    const shots = await (options.shooter ?? screenshot)(
      workspace,
      spec,
      RENDER_DIR,
      [
        { page: home.id, locale: spec.defaultLocale, viewport: 'mobile' },
        { page: home.id, locale: spec.defaultLocale, viewport: 'desktop' },
      ],
      SHOTS_DIR,
    );
    counts.screenshots = shots.length;
    if (shots.length < 2)
      blocking.push({
        kind: 'screenshot',
        message: 'The home page screenshots (mobile and desktop) were not produced.',
      });
    return report(shots);
  } catch (error) {
    blocking.push({
      kind: 'screenshot',
      message: `Screenshots failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    return report();
  }
}

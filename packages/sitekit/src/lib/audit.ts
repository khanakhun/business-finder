import { createServer } from 'node:net';
import { staticPath } from '@bf/site-blocks/static';
import type { SiteLocale, SiteSpec } from '@bf/site-schema';
import type { Route } from 'playwright';
import { serveFolder, VIEWPORTS, type Viewport } from './screenshot.ts';
import type { Workspace } from './workspace.ts';

// audit (BF-045): what the quality gates measure on a rendered site — axe-core accessibility (every page × locale at
// mobile and desktop) and Lighthouse (home and the heaviest inner page, mobile and desktop presets), against the
// static render served on 127.0.0.1. Nothing leaves the machine: the browser reaches the loopback server only. Each
// finding names its page, locale, viewport and, for axe, the block it sits in (the section's `data-block` id).

export interface AxeFinding {
  readonly page: string;
  readonly locale: SiteLocale;
  readonly viewport: Viewport;
  /** axe's rule id (`color-contrast`, `heading-order`…). */
  readonly rule: string;
  readonly impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  readonly help: string;
  /** The blocks (section DOM ids) and selectors of the failing nodes. */
  readonly nodes: readonly {
    readonly target: string;
    readonly blockDomId: string | null;
    readonly html: string;
  }[];
}

export interface LighthouseAudit {
  readonly id: string;
  readonly title: string;
  readonly score: number | null;
  readonly displayValue?: string;
}

export interface LighthouseFinding {
  readonly page: string;
  readonly locale: SiteLocale;
  readonly preset: 'mobile' | 'desktop';
  /** Category scores, 0–100. */
  readonly scores: {
    readonly performance: number | null;
    readonly accessibility: number | null;
    readonly bestPractices: number | null;
    readonly seo: number | null;
  };
  /** Audits that scored below 0.9 (or 0 for binary ones), for the gates to explain and tag. */
  readonly failing: readonly LighthouseAudit[];
}

/** A screenshot for the visual critic: what was shot, and the workspace file. */
export interface CriticShot {
  readonly page: string;
  readonly viewport: 'desktop' | 'mobile';
  readonly file: string;
}

export interface AuditReport {
  readonly axe: readonly AxeFinding[];
  readonly lighthouse: readonly LighthouseFinding[];
  readonly screenshots?: readonly CriticShot[];
  readonly pages: readonly string[];
  readonly durationMs: number;
}

export interface AuditOptions {
  readonly pages?: readonly string[];
  readonly viewports?: readonly Viewport[];
  readonly axe?: boolean;
  readonly lighthouse?: boolean;
  /** The visual critic's screenshots in this folder: home at desktop and mobile, the heaviest inner page at desktop. */
  readonly screenshotsDir?: string;
}

/** The critic's views: desktop 1280 px wide, mobile 390 px at 2×; long pages cut at a few screens. */
const CRITIC_VIEWS = {
  desktop: { viewport: { width: 1280, height: 800 }, scale: 1, maxHeight: 2400 },
  mobile: { viewport: { width: 390, height: 844 }, scale: 2, maxHeight: 1300 },
} as const;

/** The worker's copies of the site's assets (the sandbox has no network): `{ url: workspace file }`. */
export const ASSET_MAP = '.sitekit/asset-map.json';

const MEDIA: Record<string, string> = {
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

/** A free loopback port (Chromium's remote debugging, which Lighthouse drives). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Lighthouse's audits gone wrong: below 0.9, skipping the informative ones (no score). */
const failingAudits = (
  audits: Record<
    string,
    { id: string; title: string; score: number | null; displayValue?: string; scoreDisplayMode?: string }
  >,
) =>
  Object.values(audits)
    .filter(
      (audit) =>
        audit.score !== null &&
        audit.score < 0.9 &&
        audit.scoreDisplayMode !== 'informative' &&
        audit.scoreDisplayMode !== 'manual',
    )
    .map((audit) => ({
      id: audit.id,
      title: audit.title.slice(0, 200),
      score: audit.score,
      ...(audit.displayValue ? { displayValue: audit.displayValue.slice(0, 120) } : {}),
    }))
    .slice(0, 40);

const percent = (score: number | null | undefined) =>
  typeof score === 'number' ? Math.round(score * 100) : null;

/** Home and the inner page with the most blocks: where Lighthouse runs (the costly part). */
export function lighthousePages(spec: SiteSpec): string[] {
  const [home, ...rest] = spec.pages;
  const heaviest = [...rest].sort((a, b) => b.blocks.length - a.blocks.length)[0];
  return [home?.id, heaviest?.id].filter((id): id is string => Boolean(id));
}

/** The audit of the rendered site (render first: `renderSite`). */
export async function audit(
  workspace: Workspace,
  spec: SiteSpec,
  renderDir: string,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const started = performance.now();
  const pages = options.pages?.length ? [...options.pages] : spec.pages.map((page) => page.id);
  const viewports = options.viewports?.length ? [...options.viewports] : (['mobile', 'desktop'] as const);
  const { chromium } = await import('playwright');
  const root = await workspace.resolve(renderDir);
  const server = await serveFolder(root);
  const port = await freePort();
  const browser = await chromium.launch({
    args: ['--disable-gpu', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  });
  const urlOf = (pageId: string, locale: SiteLocale) => {
    const page = spec.pages.find((candidate) => candidate.id === pageId);
    if (!page)
      throw new Error(`There is no page "${pageId}". Pages: ${spec.pages.map((p) => p.id).join(', ')}.`);
    return `${server.origin}/${staticPath(spec, page, locale).replace(/index\.html$/, '')}`;
  };
  const assets = (await workspace.readJson(ASSET_MAP).catch(() => ({}))) as Record<string, string>;
  /** Loopback answers; mapped assets from their local copy; everything else is refused (nothing leaves). */
  const route = async (request: Route) => {
    const url = request.request().url();
    if (url.startsWith(`${server.origin}/`)) return request.continue();
    const file = assets[url];
    if (typeof file === 'string') {
      const extension = new URL(url).pathname.match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? '';
      return request.fulfill({
        path: await workspace.resolve(file),
        contentType: MEDIA[extension] ?? 'application/octet-stream',
      });
    }
    return request.abort('blockedbyclient');
  };
  const axe: AxeFinding[] = [];
  const lighthouse: LighthouseFinding[] = [];
  const screenshots: CriticShot[] = [];
  try {
    if (options.axe !== false) {
      const { AxeBuilder } = await import('@axe-core/playwright');
      for (const pageId of pages)
        for (const locale of spec.locales)
          for (const viewport of viewports) {
            const context = await browser.newContext({
              viewport: VIEWPORTS[viewport],
              reducedMotion: 'reduce',
              locale,
              serviceWorkers: 'block',
            });
            await context.route('**/*', route);
            const tab = await context.newPage();
            await tab.goto(urlOf(pageId, locale), { waitUntil: 'load' });
            const result = await new AxeBuilder({ page: tab })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
              .analyze();
            for (const violation of result.violations) {
              const nodes = [];
              for (const node of violation.nodes.slice(0, 10)) {
                const target = node.target.map(String).join(' ');
                const blockDomId = await tab
                  .evaluate(
                    (selector) =>
                      document.querySelector(selector)?.closest('section[data-block]')?.id ?? null,
                    String(node.target[0] ?? ''),
                  )
                  .catch(() => null);
                nodes.push({ target: target.slice(0, 300), blockDomId, html: node.html.slice(0, 300) });
              }
              axe.push({
                page: pageId,
                locale,
                viewport,
                rule: violation.id,
                impact: violation.impact ?? null,
                help: violation.help.slice(0, 300),
                nodes,
              });
            }
            await context.close();
          }
    }
    if (options.lighthouse !== false) {
      const { default: run, desktopConfig } = await import('lighthouse');
      for (const pageId of lighthousePages(spec).filter((id) => pages.includes(id)))
        for (const preset of ['mobile', 'desktop'] as const) {
          const locale = spec.locales[0] as SiteLocale;
          const result = await run(
            urlOf(pageId, locale),
            {
              port,
              output: 'json',
              logLevel: 'error',
              onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
              // Previews are `noindex` by design: crawlability is not ours to fail.
              skipAudits: ['is-crawlable'],
            },
            preset === 'desktop' ? desktopConfig : undefined,
          );
          const lhr = result?.lhr;
          if (!lhr) continue;
          lighthouse.push({
            page: pageId,
            locale,
            preset,
            scores: {
              performance: percent(lhr.categories.performance?.score),
              accessibility: percent(lhr.categories.accessibility?.score),
              bestPractices: percent(lhr.categories['best-practices']?.score),
              seo: percent(lhr.categories.seo?.score),
            },
            failing: failingAudits(lhr.audits as never),
          });
        }
    }
    if (options.screenshotsDir) {
      const [home, inner] = lighthousePages(spec);
      const requests = [
        ...(home
          ? ([
              { page: home, viewport: 'desktop' },
              { page: home, viewport: 'mobile' },
            ] as const)
          : []),
        ...(inner && inner !== home ? ([{ page: inner, viewport: 'desktop' }] as const) : []),
      ];
      for (const request of requests) {
        const view = CRITIC_VIEWS[request.viewport];
        const locale = spec.locales[0] as SiteLocale;
        const context = await browser.newContext({
          viewport: view.viewport,
          deviceScaleFactor: view.scale,
          reducedMotion: 'reduce',
          locale,
          serviceWorkers: 'block',
        });
        await context.route('**/*', route);
        const tab = await context.newPage();
        await tab.goto(urlOf(request.page, locale), { waitUntil: 'load' });
        await tab.evaluate(() => document.fonts.ready);
        const height = Math.min(
          view.maxHeight,
          await tab.evaluate(() => document.documentElement.scrollHeight),
        );
        const file = `${options.screenshotsDir}/${request.page}.${request.viewport}.png`;
        await workspace.writeText(file, '');
        await tab.screenshot({
          path: await workspace.resolve(file),
          // The page's top, a few screens long (a clip beyond the viewport needs fullPage).
          fullPage: true,
          clip: { x: 0, y: 0, width: view.viewport.width, height },
          animations: 'disabled',
          caret: 'hide',
        });
        screenshots.push({ page: request.page, viewport: request.viewport, file });
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return {
    axe,
    lighthouse,
    ...(options.screenshotsDir ? { screenshots } : {}),
    pages,
    durationMs: Math.round(performance.now() - started),
  };
}

import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { staticPath } from '@bf/site-blocks/static';
import type { SiteLocale, SiteSpec } from '@bf/site-schema';
import type { Workspace } from './workspace.ts';

// screenshot (BF-042): Playwright Chromium on the static render, served by an ephemeral server on 127.0.0.1; every
// other request is blocked, animations off, fixed viewports and scale — the same render gives the same pixels.

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;
export type Viewport = keyof typeof VIEWPORTS;

export interface Shot {
  readonly page: string;
  readonly locale: SiteLocale;
  readonly viewport: Viewport;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** A static server for one folder, loopback only, refusing paths that leave it. */
export async function serveFolder(root: string): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let path = normalize(join(root, decodeURIComponent(url.pathname)));
      if (path !== root && !path.startsWith(root + sep)) throw new Error('outside');
      if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, 'index.html');
      const body = await readFile(path);
      response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ScreenshotRequest {
  readonly page: string;
  readonly locale: SiteLocale;
  readonly viewport: Viewport;
  readonly fullPage?: boolean;
}

export type Shooter = (
  workspace: Workspace,
  spec: SiteSpec,
  renderDir: string,
  requests: readonly ScreenshotRequest[],
  outDir: string,
) => Promise<Shot[]>;

/** Screenshots of rendered pages (render first: `renderSite`). */
export const screenshot: Shooter = async (workspace, spec, renderDir, requests, outDir) => {
  const { chromium } = await import('playwright');
  const root = await workspace.resolve(renderDir);
  const server = await serveFolder(root);
  const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-gpu'] });
  const shots: Shot[] = [];
  try {
    for (const request of requests) {
      const page = spec.pages.find((candidate) => candidate.id === request.page);
      if (!page)
        throw new Error(
          `There is no page "${request.page}". Pages: ${spec.pages.map((p) => p.id).join(', ')}.`,
        );
      const size = VIEWPORTS[request.viewport];
      const context = await browser.newContext({
        viewport: size,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        colorScheme: 'light',
        locale: request.locale,
        timezoneId: 'UTC',
        serviceWorkers: 'block',
      });
      // Nothing leaves the machine: only the loopback server answers.
      await context.route('**/*', (route) =>
        route.request().url().startsWith(`${server.origin}/`)
          ? route.continue()
          : route.abort('blockedbyclient'),
      );
      const tab = await context.newPage();
      const path = staticPath(spec, page, request.locale).replace(/index\.html$/, '');
      await tab.goto(`${server.origin}/${path}`, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);
      const file = `${outDir}/${request.page}.${request.locale}.${request.viewport}${request.fullPage ? '.full' : ''}.png`;
      const absolute = await workspace.resolve(file);
      await workspace.writeText(file, '');
      const buffer = await tab.screenshot({
        path: absolute,
        fullPage: request.fullPage ?? false,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      });
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      shots.push({
        page: request.page,
        locale: request.locale,
        viewport: request.viewport,
        file,
        width,
        height,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
  return shots;
};

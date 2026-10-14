import { gzipSync } from 'node:zlib';
import { expect, test } from './fixtures.ts';

test('shell LCP stays under 2.5 s (production build)', async ({ page }) => {
  await page.goto('/');
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve(entries[entries.length - 1]?.startTime ?? 0);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      }),
  );
  test.info().annotations.push({ type: 'LCP (ms)', description: lcp.toFixed(0) });
  expect(lcp).toBeLessThan(2_500);
});

test('shell JavaScript stays under 200 kB gzipped', async ({ page }) => {
  // Measure the shell only: link prefetching downloads other routes' code in the background, which is not part of
  // the first-load budget (and made the number depend on timing).
  await page.route(/[?&]_rsc=/, (route) => route.abort());
  const scripts = new Map<string, Promise<Buffer>>();
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') scripts.set(response.url(), response.body());
  });
  await page.goto('/');
  await page.getByTestId('api-version').waitFor();
  const sizes = await Promise.all([...scripts.values()].map(async (body) => gzipSync(await body).length));
  const totalKb = sizes.reduce((a, b) => a + b, 0) / 1024;
  test.info().annotations.push({
    type: 'Shell JS (kB gzip)',
    description: `${totalKb.toFixed(1)} kB in ${sizes.length} files`,
  });
  expect(totalKb).toBeLessThan(200);
});

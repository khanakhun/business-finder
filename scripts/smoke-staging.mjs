#!/usr/bin/env node
// Smoke test of a deployed environment from the outside (BF-025): the API is ready, the sign-in page renders with
// this deployment's API URL, and the system info answers — with the expected release when one is given. Exits
// non-zero if any check fails (after a deploy this only reports: the rollback decision is the health gate's).
//   node scripts/smoke-staging.mjs https://app.staging.example.com https://api.staging.example.com [<release>]
const [appUrl, apiUrl, release] = process.argv.slice(2);
if (!appUrl || !apiUrl) {
  console.error('usage: smoke-staging.mjs <app-url> <api-url> [<release>]');
  process.exit(64);
}

const TIMEOUT_MS = 10_000;
const checks = [
  {
    name: 'api ready',
    url: `${apiUrl}/health/ready`,
    test: async (response) => (await response.json()).status === 'ok',
  },
  {
    name: 'web ready',
    url: `${appUrl}/health/ready`,
    test: async (response) => (await response.json()).status === 'ok',
  },
  {
    name: 'sign-in page',
    url: `${appUrl}/sign-in`,
    // The page embeds the API URL it was configured with at run time (apps/web/src/lib/public-env.ts).
    test: async (response) => (await response.text()).includes(new URL(apiUrl).hostname),
  },
  {
    name: 'system info',
    url: `${apiUrl}/v1/system/info`,
    test: async (response) => {
      const { version } = await response.json();
      return typeof version === 'string' && (!release || version === release);
    },
  },
];

let failed = 0;
for (const check of checks) {
  const started = Date.now();
  try {
    const response = await fetch(check.url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ok = response.status === 200 && (await check.test(response));
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${check.name} — ${response.status} in ${Date.now() - started} ms`);
    if (!ok) failed++;
  } catch (error) {
    console.log(`FAIL ${check.name} — ${error instanceof Error ? error.message : String(error)}`);
    failed++;
  }
}
process.exit(failed === 0 ? 0 : 1);

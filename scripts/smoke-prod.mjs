#!/usr/bin/env node
// Post-deploy smoke test of production from the outside (BF-061). Unlike the staging one it decides: a failure makes
// the deploy workflow roll back to the previous release. Checks the API and dashboard are ready, the sign-in page
// is this deployment's, the system info reports the expected release, the unsubscribe host answers (a bad token is
// a page, never a 5xx), and — when a canary preview is configured — the renderer serves it.
//   node scripts/smoke-prod.mjs <base-domain> <release> [<canary-preview-url>]
// Retries each check for up to a minute (Caddy may still be finishing a certificate or a rollout).
const [baseDomain, release, canaryUrl] = process.argv.slice(2);
if (!baseDomain || !release) {
  console.error('usage: smoke-prod.mjs <base-domain> <release> [<canary-preview-url>]');
  process.exit(64);
}
const appUrl = `https://app.${baseDomain}`;
const apiUrl = `https://api.${baseDomain}`;
const unsubscribeUrl = `https://u.${baseDomain}/u/bf-smoke-invalid-token`;

const TIMEOUT_MS = 10_000;
const RETRY_FOR_MS = 60_000;
const json = async (response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};
const checks = [
  {
    name: 'api ready',
    url: `${apiUrl}/health/ready`,
    test: async (r) => r.status === 200 && (await json(r)).status === 'ok',
  },
  {
    name: 'web ready',
    url: `${appUrl}/health/ready`,
    test: async (r) => r.status === 200 && (await json(r)).status === 'ok',
  },
  {
    name: 'sign-in page',
    url: `${appUrl}/sign-in`,
    test: async (r) => r.status === 200 && (await r.text()).includes(new URL(apiUrl).hostname),
  },
  {
    name: 'release',
    url: `${apiUrl}/v1/system/info`,
    test: async (r) => r.status === 200 && (await json(r)).version === release,
  },
  { name: 'unsubscribe host', url: unsubscribeUrl, test: async (r) => r.status >= 200 && r.status < 500 },
  ...(canaryUrl
    ? [
        {
          name: 'canary preview',
          url: canaryUrl,
          test: async (r) => r.status === 200 && (await r.text()).includes('<html'),
        },
      ]
    : []),
];

async function run(check) {
  const deadline = Date.now() + RETRY_FOR_MS;
  let last = '';
  while (true) {
    const started = Date.now();
    try {
      const response = await fetch(check.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (await check.test(response))
        return `ok   ${check.name} — ${response.status} in ${Date.now() - started} ms`;
      last = `status ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) return `FAIL ${check.name} — ${last}`;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

let failed = 0;
for (const check of checks) {
  const line = await run(check);
  console.log(line);
  if (line.startsWith('FAIL')) failed++;
}
process.exit(failed === 0 ? 0 : 1);

import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

// Headers that do not depend on the request; the per-request CSP (with its nonce) and X-Robots-Tag are set in
// src/proxy.ts.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  // The Docker image runs the self-contained server; `pnpm start` keeps `next start`.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone', outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)) }
    : {}),
  // Workspace packages are consumed as TypeScript source (packages/README.md).
  transpilePackages: ['@bf/site-blocks', '@bf/site-schema', '@bf/contracts', '@bf/config', '@bf/db'],
  poweredByHeader: false,
  experimental: {
    // Sites take no visitor body (the contact form posts to the API): the proxy buffers at most this much of one.
    proxyClientMaxBodySize: '16kb',
  },
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // The block library's stylesheet and fonts: stable names, refreshed with each deploy.
      {
        source: '/_bf/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, stale-while-revalidate=86400' }],
      },
    ];
  },
};

export default nextConfig;

// pnpm --filter @bf/sites seed:fixtures — publishes the four fixture sites as previews in the local database, so the
// renderer can be tried at http://<slug>.sites.localhost:<SITES_PORT>/ without the dashboard (BF-036). Local only:
// it refuses production and any database that is not on this machine, and replaces only its own workspace (and the
// businesses of its sites) each run.
import { closeDb } from '@bf/db';
import { organization, orgSettings } from '@bf/db/schema';
import { BASE_DOMAIN, env } from '../e2e/env.ts';
import { db, dropWorkspace, publish } from '../e2e/seed.ts';

const ORG_SLUG = 'local-fixture-sites';
const LABEL = 'Local fixture';
const SITES = [
  { fixtureName: 'salon-gustavia', slug: 'salon-gustavia-demo01' },
  { fixtureName: 'cafe-saint-jean', slug: 'cafe-saint-jean-demo02' },
  { fixtureName: 'hardware-store-lorient', slug: 'hardware-lorient-demo03' },
  { fixtureName: 'villa-agency', slug: 'villa-agency-demo04' },
];

const client = db('pnpm sites:seed');
try {
  await dropWorkspace(client, ORG_SLUG);
  const orgId = crypto.randomUUID();
  await client.insert(organization).values({ id: orgId, name: 'Local fixture sites', slug: ORG_SLUG });
  await client
    .insert(orgSettings)
    .values({ organizationId: orgId, agencyName: 'Agence locale', websiteUrl: null });
  const expiresAt = new Date(Date.now() + 30 * 86_400_000);
  for (const site of SITES) await publish(client, orgId, { ...site, expiresAt, label: LABEL });
  // Published under sites.localhost (the local default of SITES_BASE_DOMAIN).
  process.stdout.write('Published (previews, 30 days):\n');
  for (const site of SITES)
    process.stdout.write(`  http://${site.slug}.${BASE_DOMAIN}:${env.SITES_PORT ?? '3100'}/\n`);
} finally {
  await closeDb(client);
}

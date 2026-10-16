import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { closeDb, createDb, type DbClient } from '@bf/db';
import { businesses, organization, orgSettings, sitePublications, sites, siteVersions } from '@bf/db/schema';
import { aBusiness } from '@bf/testing';
import { eq } from 'drizzle-orm';
import { BASE_DOMAIN, env } from './env.ts';

// The e2e renderer's data, written straight to the database (the API is not under test here): one workspace with
// three published sites — an active preview, an expired one and an unpublished one.

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8'));

export const ORG_SLUG = 'e2e-sites-renderer';
export const SLUGS = {
  active: 'e2e-salon-k3x9p2',
  expired: 'e2e-cafe-m4w7q8',
  unpublished: 'e2e-hardware-p2z6n5',
  /** Changed by the revalidation test only. */
  revalidated: 'e2e-villa-r8t5v3',
};
export const AGENCY = { name: 'Agence Exemple', url: 'https://agence.example' };

export const db = (): DbClient => createDb({ url: env.DATABASE_URL ?? '', max: 2 });

const uuid = () => crypto.randomUUID();

async function publish(
  client: DbClient,
  orgId: string,
  input: { slug: string; fixtureName: string; expiresAt: Date; status?: 'active' | 'unpublished' },
): Promise<{ siteId: string; versionId: string; publicationId: string }> {
  const business = aBusiness({ displayName: `E2E ${input.fixtureName}`, locality: 'Gustavia' });
  await client.insert(businesses).values(business);
  const businessId = business.id;
  const siteId = uuid();
  const spec = fixture(input.fixtureName);
  await client.insert(sites).values({
    id: siteId,
    organizationId: orgId,
    businessId,
    slug: input.slug,
    name: `E2E ${input.fixtureName}`,
    status: 'preview',
    defaultLocale: String(spec.defaultLocale ?? 'fr'),
  });
  const versionId = await addVersion(client, siteId, spec, 1);
  const publicationId = uuid();
  await client.insert(sitePublications).values({
    id: publicationId,
    siteId,
    versionId,
    environment: 'preview',
    hostname: `${input.slug}.${BASE_DOMAIN}`,
    status: input.status ?? 'active',
    expiresAt: input.expiresAt,
    ...(input.status === 'unpublished' ? { endedAt: new Date() } : {}),
  });
  return { siteId, versionId, publicationId };
}

/** A new version of a site, made current (as the API's save does). */
export async function addVersion(
  client: DbClient,
  siteId: string,
  spec: Record<string, unknown>,
  versionNumber: number,
): Promise<string> {
  const versionId = uuid();
  await client.insert(siteVersions).values({
    id: versionId,
    siteId,
    versionNumber,
    spec,
    specHash: 'e2e'.padEnd(64, '0'),
    schemaVersion: 1,
    authorType: 'import',
    validation: { issues: [] },
  });
  await client.update(sites).set({ currentVersionId: versionId }).where(eq(sites.id, siteId));
  return versionId;
}

export async function seed(): Promise<void> {
  const client = db();
  try {
    await client.delete(organization).where(eq(organization.slug, ORG_SLUG));
    const orgId = uuid();
    await client.insert(organization).values({ id: orgId, name: 'Workspace E2E', slug: ORG_SLUG });
    await client
      .insert(orgSettings)
      .values({ organizationId: orgId, agencyName: AGENCY.name, websiteUrl: AGENCY.url });
    const day = 86_400_000;
    await publish(client, orgId, {
      slug: SLUGS.active,
      fixtureName: 'salon-gustavia',
      expiresAt: new Date(Date.now() + 30 * day),
    });
    await publish(client, orgId, {
      slug: SLUGS.revalidated,
      fixtureName: 'salon-gustavia',
      expiresAt: new Date(Date.now() + 30 * day),
    });
    await publish(client, orgId, {
      slug: SLUGS.expired,
      fixtureName: 'cafe-saint-jean',
      expiresAt: new Date(Date.now() - day),
    });
    await publish(client, orgId, {
      slug: SLUGS.unpublished,
      fixtureName: 'hardware-store-lorient',
      expiresAt: new Date(Date.now() + day),
      status: 'unpublished',
    });
  } finally {
    await closeDb(client);
  }
}

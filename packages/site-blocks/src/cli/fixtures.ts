import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type SiteSpec, SiteSpecSchema } from '@bf/site-schema';

/** The four fixture sites of @bf/site-schema (validated). */
export const FIXTURE_NAMES = [
  'salon-gustavia',
  'cafe-saint-jean',
  'hardware-store-lorient',
  'villa-agency',
] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

const schemaDir = dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json'));

export function readFixture(name: FixtureName): SiteSpec {
  return SiteSpecSchema.parse(JSON.parse(readFileSync(join(schemaDir, 'fixtures', `${name}.json`), 'utf8')));
}

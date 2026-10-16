import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type FactRegistry, FactRegistrySchema, type SiteSpec, SiteSpecSchema } from '@bf/site-schema';

const schemaDir = dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json'));
const read = (path: string) => JSON.parse(readFileSync(join(schemaDir, 'fixtures', path), 'utf8'));

export const FIXTURES = [
  'salon-gustavia',
  'cafe-saint-jean',
  'hardware-store-lorient',
  'villa-agency',
] as const;
export type Fixture = (typeof FIXTURES)[number];

export const fixture = (name: Fixture): SiteSpec => SiteSpecSchema.parse(read(`${name}.json`));
export const facts = (name: Fixture): FactRegistry => FactRegistrySchema.parse(read(`facts/${name}.json`));

/** A stylesheet stand-in for static renders in unit tests (the built one needs `pnpm build`). */
export const TEST_CSS = '.bf-site{color:red}';

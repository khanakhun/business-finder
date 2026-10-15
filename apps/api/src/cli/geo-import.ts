// pnpm geo:import --pack <bl|nl-pc4|us-zcta> [--file <GeoJSONSeq>] [--prefix <zip prefix>] | --list
// Imports an area pack into geo_areas (idempotent: re-running changes nothing). Sources and licences:
// packages/db/seed/geo/<pack>/README.md.
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { closeDb, createDb } from '@bf/db';
import { GEO_PACKS, importPack } from '../modules/geo/application/packs/index.ts';
import { DrizzleGeoAreaRepository } from '../modules/geo/infrastructure/drizzle-geo-area.repository.ts';
import { loadAppEnv } from '../modules/platform/config/app-env.ts';

const { values } = parseArgs({
  options: {
    pack: { type: 'string' },
    file: { type: 'string' },
    prefix: { type: 'string' },
    list: { type: 'boolean' },
  },
});
if (values.list || !values.pack) {
  for (const pack of Object.values(GEO_PACKS)) console.log(`${pack.name.padEnd(8)} ${pack.source}`);
  process.exit(values.list ? 0 : 1);
}
const pack = GEO_PACKS[values.pack];
if (!pack) {
  console.error(`Unknown pack "${values.pack}". Known: ${Object.keys(GEO_PACKS).join(', ')}`);
  process.exit(1);
}
const env = loadAppEnv('http');
const db = createDb({ url: env.DATABASE_URL, max: 2, applicationName: 'bf-geo-import' });
try {
  const report = await importPack(pack, new DrizzleGeoAreaRepository(db), {
    ...(values.file ? { file: values.file } : {}),
    ...(values.prefix ? { prefix: values.prefix } : {}),
  });
  console.log(`geo:import ${report.pack}: ${report.written} written, ${report.unchanged} unchanged`);
} finally {
  await closeDb(db);
}

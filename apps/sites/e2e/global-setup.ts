import { seed } from './seed.ts';

// biome-ignore lint/style/noDefaultExport: Playwright loads a global setup's default export
export default async function globalSetup(): Promise<void> {
  await seed();
}

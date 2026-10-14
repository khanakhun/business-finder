import { defineConfig } from 'drizzle-kit';

// Run through `pnpm db:*` (src/cli/kit.ts), which provides DATABASE_URL for commands that connect.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  // Overridden by `db:check` to generate into a scratch copy when probing for drift.
  out: process.env.BF_DRIZZLE_OUT ?? './migrations',
  casing: 'snake_case',
  strict: true,
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});

import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

export type VitestConfigType = 'unit' | 'int';

export interface VitestConfigOptions {
  /** `unit` runs `*.test.ts` with coverage gates; `int` runs `*.int.test.ts` against real containers. */
  readonly type: VitestConfigType;
  /** Package-specific setup files, run after the shared `@bf/testing/setup`. */
  readonly setupFiles?: readonly string[];
  /** Adds machine-readable reports for CI. Defaults to the `CI` environment variable. */
  readonly ci?: boolean;
}

/** Coverage gates from docs/conventions/testing.md §8: packages ≥ 80% lines, `domain/` ≥ 90% branches. */
export const UNIT_COVERAGE_THRESHOLDS = {
  lines: 80,
  // Files matching a glob are checked against its own thresholds, so it restates the line floor.
  '**/domain/**': { lines: 80, branches: 90 },
} as const;

/** Absolute path of the shared setup file (seeds faker per test). */
export const SETUP_FILE = fileURLToPath(new URL('./setup.ts', import.meta.url));

const UNIT_TESTS = 'src/**/*.test.{ts,tsx}';
const INT_TESTS = 'src/**/*.int.test.{ts,tsx}';
const INT_TESTS_ANYWHERE = '**/*.int.test.{ts,tsx}';

/**
 * Vitest config shared by every TypeScript workspace. Use from a package's `vitest.config.ts`:
 *
 * ```ts
 * export default defineVitestConfig({ type: 'unit' });
 * ```
 */
export function defineVitestConfig(options: VitestConfigOptions): ViteUserConfig {
  const { type, setupFiles = [], ci = process.env.CI === 'true' } = options;
  const isUnit = type === 'unit';

  return defineConfig({
    test: {
      include: [isUnit ? UNIT_TESTS : INT_TESTS],
      exclude: ['**/node_modules/**', '**/dist/**', ...(isUnit ? [INT_TESTS_ANYWHERE] : [])],
      // A misconfigured glob must fail loudly instead of reporting green with zero tests.
      passWithNoTests: false,
      setupFiles: [SETUP_FILE, ...setupFiles],
      reporters: ci ? ['default', 'junit'] : ['default'],
      ...(ci ? { outputFile: { junit: `reports/junit.${type}.xml` } } : {}),
      // Integration tests start Postgres/Valkey containers in hooks.
      ...(isUnit ? {} : { testTimeout: 60_000, hookTimeout: 120_000 }),
      coverage: {
        // Off by default so ad-hoc filtered runs (`vitest run -t …`) don't trip the gates; a package's
        // `test` script passes `--coverage`. Integration runs never gate coverage.
        enabled: false,
        provider: 'v8',
        // Listing sources makes untested files count as 0% instead of being silently skipped.
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['**/*.test.{ts,tsx}', '**/__fixtures__/**', '**/*.d.ts'],
        reporter: ['text-summary', 'json-summary', 'lcov'],
        ...(isUnit ? { thresholds: UNIT_COVERAGE_THRESHOLDS } : {}),
      },
    },
  });
}

import { describe, expect, it } from 'vitest';
import {
  defineVitestConfig,
  PG_GLOBAL_SETUP,
  SETUP_FILE,
  UNIT_COVERAGE_THRESHOLDS,
} from './vitest-config.ts';

describe('defineVitestConfig', () => {
  describe('unit', () => {
    const { test } = defineVitestConfig({ type: 'unit', ci: false });

    it('fails when no test file matches', () => {
      expect(test?.passWithNoTests).toBe(false);
    });

    it('runs *.test.ts files but not integration tests', () => {
      expect(test?.include).toEqual(['src/**/*.test.{ts,tsx}']);
      expect(test?.exclude).toContain('**/*.int.test.{ts,tsx}');
    });

    it('collects V8 coverage over all source files and enforces the thresholds from testing.md §8', () => {
      expect(test?.coverage).toMatchObject({
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        thresholds: UNIT_COVERAGE_THRESHOLDS,
      });
      expect(UNIT_COVERAGE_THRESHOLDS).toEqual({
        lines: 80,
        '**/domain/**': { lines: 80, branches: 90 },
      });
    });

    it('leaves coverage to the --coverage flag so filtered runs are not gated', () => {
      expect(test?.coverage?.enabled).toBe(false);
    });

    it('keeps test files and fixtures out of coverage', () => {
      const exclude = test?.coverage?.exclude ?? [];
      expect(exclude).toEqual(expect.arrayContaining(['**/*.test.{ts,tsx}', '**/__fixtures__/**']));
    });

    it('registers the shared setup file', () => {
      expect(test?.setupFiles).toEqual([SETUP_FILE]);
    });

    it('uses the default reporter outside CI', () => {
      expect(test?.reporters).toEqual(['default']);
    });
  });

  describe('int', () => {
    const { test } = defineVitestConfig({ type: 'int', ci: false });

    it('fails when no test file matches', () => {
      expect(test?.passWithNoTests).toBe(false);
    });

    it('runs only *.int.test.ts files', () => {
      expect(test?.include).toEqual(['src/**/*.int.test.{ts,tsx}']);
      expect(test?.exclude).not.toContain('**/*.int.test.{ts,tsx}');
    });

    it('allows time for containers to start and does not gate coverage', () => {
      expect(test?.testTimeout).toBeGreaterThanOrEqual(30_000);
      expect(test?.hookTimeout).toBeGreaterThanOrEqual(60_000);
      expect(test?.coverage).not.toHaveProperty('thresholds');
    });
  });

  it('runs in node unless a DOM environment is asked for', () => {
    expect(defineVitestConfig({ type: 'unit' }).test?.environment).toBe('node');
    expect(defineVitestConfig({ type: 'unit', environment: 'happy-dom' }).test?.environment).toBe(
      'happy-dom',
    );
  });

  it('appends package-specific setup files after the shared one', () => {
    const { test } = defineVitestConfig({ type: 'unit', setupFiles: ['./src/test-setup.ts'] });
    expect(test?.setupFiles).toEqual([SETUP_FILE, './src/test-setup.ts']);
  });

  it('lets apps narrow unit coverage to their logic layers', () => {
    const { test } = defineVitestConfig({ type: 'unit', coverageInclude: ['src/modules/*/domain/**'] });
    expect(test?.coverage?.include).toEqual(['src/modules/*/domain/**']);
  });

  it('appends package-specific coverage exclusions', () => {
    const { test } = defineVitestConfig({ type: 'unit', coverageExclude: ['src/cli/**'] });
    expect(test?.coverage?.exclude).toEqual(expect.arrayContaining(['**/*.test.{ts,tsx}', 'src/cli/**']));
  });

  it('registers global setup files only when asked', () => {
    expect(defineVitestConfig({ type: 'int' }).test).not.toHaveProperty('globalSetup');
    const { test } = defineVitestConfig({ type: 'int', globalSetup: [PG_GLOBAL_SETUP] });
    expect(test?.globalSetup).toEqual([PG_GLOBAL_SETUP]);
    expect(PG_GLOBAL_SETUP).toMatch(/db[/\\]global-setup\.ts$/);
  });

  it('adds a JUnit report in CI', () => {
    const { test } = defineVitestConfig({ type: 'unit', ci: true });
    expect(test?.reporters).toEqual(['default', 'junit']);
    expect(test?.outputFile).toEqual({ junit: 'reports/junit.unit.xml' });
  });
});

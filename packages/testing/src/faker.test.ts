import { base, en, Faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { faker, seedFor, testSeedKey } from './faker.ts';

describe('seedFor', () => {
  it('is deterministic', () => {
    expect(seedFor('src/a.test.ts::a')).toBe(seedFor('src/a.test.ts::a'));
  });

  it('differs between keys', () => {
    expect(seedFor('src/a.test.ts::a')).not.toBe(seedFor('src/a.test.ts::b'));
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const key of ['', 'x', 'é', 'a much longer key with spaces and ünïcödé']) {
      const seed = seedFor(key);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });
});

describe('faker', () => {
  it('is seeded from the test file and name before each test', ({ task }) => {
    const reference = new Faker({ locale: [en, base] });
    reference.seed(seedFor(testSeedKey(task.file.name, task.fullName)));

    expect(faker.string.uuid()).toBe(reference.string.uuid());
  });

  it('uses a project-relative file path so seeds match across machines', ({ task }) => {
    expect(task.file.name).toBe('src/faker.test.ts');
  });
});

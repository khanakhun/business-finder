import { beforeEach } from 'vitest';
import { faker, seedFor, testSeedKey } from './faker.ts';

// DECISION(BF-001): the seed derives from the test file *and* test name rather than the file alone, so a
// test sees the same data whether it runs alone, filtered, or after its siblings.
beforeEach(({ task }) => {
  faker.seed(seedFor(testSeedKey(task.file.name, task.fullName)));
});

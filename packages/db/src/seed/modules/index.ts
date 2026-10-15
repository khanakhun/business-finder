import type { SeedModule } from '../runner.ts';
import { taxonomySeedModule } from './taxonomy.ts';

/**
 * Seed modules in execution order. Context tickets append theirs (e.g. the category taxonomy, BF-015).
 */
export const SEED_MODULES: readonly SeedModule[] = [taxonomySeedModule];

import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Infrastructure-level feature flags (ARCHITECTURE.md §17). Product flags live in org settings. */
export const featureFlagsEnv = z.object({
  FEATURE_MAPS_SCRAPER: booleanFlag(false).describe('Enable the self-hosted Google Maps scraper provider.'),
  FEATURE_CODING_ENGINES: booleanFlag(true).describe('Enable coding-agent site generation engines.'),
  FEATURE_AUTO_SEND: booleanFlag(false).describe('Allow sequences to send without per-message approval.'),
});

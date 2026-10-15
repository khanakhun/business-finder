import { z } from 'zod';
import { booleanFlag } from '../schema.ts';

/** Infrastructure-level feature flags (ARCHITECTURE.md §17). Product flags live in org settings. */
export const featureFlagsEnv = z.object({
  FEATURE_MAPS_SCRAPER: booleanFlag(false).describe('Enable the self-hosted Google Maps scraper provider.'),
  FEATURE_CODING_ENGINES: booleanFlag(true).describe('Enable coding-agent site generation engines.'),
  FEATURE_AUTO_SEND: booleanFlag(false).describe('Allow sequences to send without per-message approval.'),
  FAKE_DISCOVERY_PROVIDER: booleanFlag(false).describe(
    'Register the fixture discovery provider (tests and E2E only; refused in production).',
  ),
  FAKE_DISCOVERY_SYNTHETIC: booleanFlag(false).describe(
    'The fixture discovery provider generates grid records instead of fixtures (benchmarks, tiling tests).',
  ),
  FAKE_SITE_INTEL: booleanFlag(false).describe(
    'Website crawls answer from a built-in fake instead of services/intel (tests and E2E only; refused in production).',
  ),
  FAKE_EMAIL_VERIFIER: booleanFlag(false).describe(
    'E-mail verification answers from a built-in fake (no SMTP or DNS; tests and E2E only; refused in production).',
  ),
  FAKE_CONNECTION_TESTS: booleanFlag(false).describe(
    'Development/E2E only: provider connection tests succeed without calling providers. Refused in production.',
  ),
});

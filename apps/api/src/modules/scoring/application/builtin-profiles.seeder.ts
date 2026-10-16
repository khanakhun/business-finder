import type { Offer } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { LOGGER } from '../../platform/logging/logger.ts';
import { BUILTIN_PROFILE_VERSIONS, BUILTIN_PROFILES } from '../domain/builtin-profiles.ts';
import { SCORING_REPOSITORY, type ScoringRepository } from './ports.ts';

// The built-in profiles live in code (domain) and in the database (scores reference their rows): every process
// makes sure their rows and current versions exist at boot (idempotent, safe when several start at once).

/** Stable ids of the built-in profiles (one per offer). */
export const BUILTIN_PROFILE_IDS: Readonly<Record<Offer, string>> = {
  new_website: '01990000-0000-7000-8000-00000000b101',
  website_redesign: '01990000-0000-7000-8000-00000000b102',
  ai_receptionist: '01990000-0000-7000-8000-00000000b103',
  booking_system: '01990000-0000-7000-8000-00000000b104',
  local_seo: '01990000-0000-7000-8000-00000000b105',
};

/** DECISION(BF-031): a workspace that chose no primary profile is listed by the new-website score. */
export const BUILTIN_PRIMARY_PROFILE_ID = BUILTIN_PROFILE_IDS.new_website;

const NAMES: Record<Offer, string> = {
  new_website: 'New website',
  website_redesign: 'Website redesign',
  ai_receptionist: 'AI receptionist',
  booking_system: 'Booking system',
  local_seo: 'Local SEO',
};

@Injectable()
export class BuiltinProfilesSeeder implements OnApplicationBootstrap {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    const offers = Object.keys(BUILTIN_PROFILES) as Offer[];
    await this.repository.ensureBuiltins(
      offers.map((offer) => ({
        id: BUILTIN_PROFILE_IDS[offer],
        offer,
        name: NAMES[offer],
        version: BUILTIN_PROFILE_VERSIONS[offer],
        config: BUILTIN_PROFILES[offer],
      })),
    );
    this.logger.debug({ profiles: offers.length }, 'built-in scoring profiles ensured');
  }
}

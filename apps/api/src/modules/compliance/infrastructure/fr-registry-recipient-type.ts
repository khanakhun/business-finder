import { type Clock } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businessRecipientTypes } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import type { RecipientTypeResolver } from '../application/ports.ts';

// Legal person or sole trader (BF-049), from the French public company registry for FR, BL and MF businesses
// (recherche-entreprises.api.gouv.fr: public, no key). Matched on the name and the postcode of the head office; the
// legal form decides (1xxx entrepreneur individuel → sole trader; 7xxx public bodies; others legal persons). Cached on
// the business 90 days (30 when not found). Any failure is `unknown` — the rules then stay conservative.

const REGISTRY = 'https://recherche-entreprises.api.gouv.fr/search';
const FR_LIKE = new Set(['FR', 'BL', 'MF']);
const TTL_DAYS = 90;
const TTL_UNKNOWN_DAYS = 30;
const TIMEOUT_MS = 4_000;

type RecipientType = Awaited<ReturnType<RecipientTypeResolver['resolve']>>;

interface RegistryResult {
  readonly siren?: string;
  readonly nom_complet?: string;
  readonly nature_juridique?: string | null;
  readonly siege?: { readonly code_postal?: string | null };
  readonly complements?: { readonly est_entrepreneur_individuel?: boolean };
}

const words = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

/** The legal form's recipient type. */
export function recipientTypeOf(result: RegistryResult): RecipientType {
  if (result.complements?.est_entrepreneur_individuel || result.nature_juridique?.startsWith('1'))
    return 'sole_trader';
  if (result.nature_juridique?.startsWith('7')) return 'public_body';
  return result.nature_juridique ? 'legal_person' : 'unknown';
}

@Injectable()
export class FrRegistryRecipientType implements RecipientTypeResolver {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  private get x() {
    return getExecutor(this.db);
  }

  async resolve(business: Parameters<RecipientTypeResolver['resolve']>[0]): Promise<RecipientType> {
    if (!business.jurisdictions.some((code) => FR_LIKE.has(code)) || !business.postalCode) return 'unknown';
    const now = this.clock.now();
    const [cached] = await this.x
      .select()
      .from(businessRecipientTypes)
      .where(eq(businessRecipientTypes.businessId, business.id))
      .limit(1);
    if (cached) {
      const days = cached.recipientType === 'unknown' ? TTL_UNKNOWN_DAYS : TTL_DAYS;
      if (now.getTime() - cached.fetchedAt.getTime() < days * 86_400_000) return cached.recipientType;
    }
    let match: RegistryResult | undefined;
    try {
      const url = new URL(REGISTRY);
      url.searchParams.set('q', business.name.slice(0, 120));
      url.searchParams.set('code_postal', business.postalCode.replace(/\s/g, ''));
      url.searchParams.set('per_page', '5');
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`registry answered ${response.status}`);
      const body = (await response.json()) as { results?: RegistryResult[] };
      const wanted = words(business.name);
      match = (body.results ?? []).find((result) => {
        const name = new Set(words(result.nom_complet ?? ''));
        return (
          result.siege?.code_postal === business.postalCode?.replace(/\s/g, '') &&
          wanted.length > 0 &&
          wanted.filter((word) => name.has(word)).length / wanted.length >= 0.6
        );
      });
    } catch (error) {
      // Not cached: the next evaluation tries again.
      this.logger.warn({ err: error, businessId: business.id }, 'company registry lookup failed');
      return 'unknown';
    }
    const type = match ? recipientTypeOf(match) : 'unknown';
    await this.x
      .insert(businessRecipientTypes)
      .values({
        businessId: business.id,
        recipientType: type,
        legalFormCode: match?.nature_juridique ?? null,
        registryId: match?.siren ?? null,
        source: 'fr_recherche_entreprises',
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: businessRecipientTypes.businessId,
        set: {
          recipientType: type,
          legalFormCode: match?.nature_juridique ?? null,
          registryId: match?.siren ?? null,
          fetchedAt: now,
        },
      });
    return type;
  }
}

import { createHash } from 'node:crypto';
import { type AiGateway, type ParseSearchIntentOutput, SearchParseIntent } from '@bf/ai';
import {
  type AreaCandidate,
  DomainError,
  type Locale,
  type LocationResolution,
  type ParseSearchIntentRequest,
  type ParseSearchIntentResponse,
  SEARCH_INTENT_WARNINGS,
  type SearchIntent,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { type CategoryCandidate, CategoryCandidateSearch } from '../../business-graph/index.ts';
import { LocationResolver } from '../../geo/index.ts';
import { AI_GATEWAY } from '../../platform/ai/ai.module.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { WorkspaceDefaults } from '../../workspace/index.ts';
import { parseIntentFallback } from '../domain/fallback-parser.ts';
import { type IntentCategory, toSearchIntent } from '../domain/post-process.ts';
import { detectLanguage, fold, normalizePrompt } from '../domain/text.ts';
import { SEARCH_INTENT_CACHE, type SearchIntentCache } from './ports.ts';

const CANDIDATES = 15;
const CACHE_TTL_SECONDS = 3_600;
const CLARIFY_OPTIONS = 4;
const DEGRADED_WARNINGS = new Set<string>([
  SEARCH_INTENT_WARNINGS.locationNotFound,
  SEARCH_INTENT_WARNINGS.locationIncomplete,
]);

const workspaceOf = (auth: AuthContext): string => {
  if (!auth.orgId) throw new Error('Search route reached without an active workspace');
  return auth.orgId;
};

/** Words that never name a trade (function words, filters, pipeline words). */
const NOT_TRADES = new Set(
  (
    'the and with without near for that this my our all any find new best rated below above less fewer more ' +
    'than least stars reviews website site web email mail phone number slow outdated qualified contacted ' +
    'les des avec sans pour dans mes nos tous toutes trouve avis etoiles note moins plus numero telephone ' +
    'courriel lent qualifies qualifiees contactes semaine month week mois'
  ).split(' '),
);

/**
 * Trigram retrieval scores short pieces (BF-015), so the prompt goes as its parts split on joining words
 * ("salons de coiffure", "cafés") and its single trade words ("bars", "spas"); the embedding sees them together.
 */
export function promptPieces(prompt: string): string[] {
  const parts = prompt
    .split(/,|;|\s(?:et|and|or|ou|with|without|avec|sans|in|at|near|à|a|au|aux|dans|pour|for|qui|that)\s/i)
    .map((p) => p.trim())
    .filter((p) => p.length >= 3);
  const words = prompt
    .split(/[\s,;.!?]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !NOT_TRADES.has(fold(w)));
  return [...new Set([...(parts.length > 1 ? parts : [prompt.trim()]), ...words])].slice(0, 12);
}

const clarifyQuestion = (language: Locale, place: string) =>
  language === 'fr' ? `Quel lieu « ${place} » voulez-vous dire ?` : `Which "${place}" do you mean?`;

/**
 * Natural-language search intent (BF-021, Facade + Chain): candidates → model → grounding → location resolution,
 * with a rule-based reading when the model is unavailable or answers outside its candidates. Cached for an hour.
 */
@Injectable()
export class SearchIntentService {
  constructor(
    @Inject(AI_GATEWAY) private readonly ai: AiGateway,
    private readonly candidateSearch: CategoryCandidateSearch,
    private readonly resolver: LocationResolver,
    private readonly defaults: WorkspaceDefaults,
    @Inject(SEARCH_INTENT_CACHE) private readonly cache: SearchIntentCache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async parse(auth: AuthContext, request: ParseSearchIntentRequest): Promise<ParseSearchIntentResponse> {
    const organizationId = workspaceOf(auth);
    const country = await this.defaults.countryHint(organizationId);
    const key = createHash('sha256')
      .update([organizationId, normalizePrompt(request.prompt), request.locale, country ?? ''].join('\u0000'))
      .digest('hex');
    const cached = await this.cache.get(key);
    if (cached) return cached;

    const language = detectLanguage(request.prompt, request.locale);
    const candidates = await this.candidates(request.prompt, organizationId);
    const bySlug = new Map<string, IntentCategory>(candidates.map((c) => [c.slug, c]));
    const { output, usedFallback } = await this.read(
      request.prompt,
      language,
      country,
      candidates,
      organizationId,
    );
    const intent = toSearchIntent(output, { candidates: bySlug, language });
    const response = await this.locate(intent, request.locale, country, organizationId);
    // A degraded reading (rule-based, no candidates, place not or partly resolved) is not worth an hour: the next
    // request may reach the model, the taxonomy search or the geocoder again.
    const degraded =
      usedFallback ||
      candidates.length === 0 ||
      response.intent.warnings.some((w) => DEGRADED_WARNINGS.has(w));
    if (!degraded) await this.cache.set(key, response, CACHE_TTL_SECONDS);
    return response;
  }

  private async candidates(prompt: string, organizationId: string): Promise<CategoryCandidate[]> {
    try {
      return await this.candidateSearch.find(promptPieces(prompt), CANDIDATES, { orgId: organizationId });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn({ code: error.code }, 'search intent without category candidates');
      return [];
    }
  }

  /** The model's reading, or the rule-based one when the model is unavailable or ignores its candidates. */
  private async read(
    prompt: string,
    language: Locale,
    country: string | null,
    candidates: readonly CategoryCandidate[],
    organizationId: string,
  ): Promise<{ readonly output: ParseSearchIntentOutput; readonly usedFallback: boolean }> {
    const fallback = () => ({
      output: parseIntentFallback(prompt, language, candidates),
      usedFallback: true,
    });
    try {
      const { output } = await this.ai.run(
        SearchParseIntent,
        {
          prompt,
          language,
          defaultCountry: country,
          candidates: candidates.map((c) => ({
            id: c.slug,
            labelEn: c.labels.en,
            labelFr: c.labels.fr,
            path: c.path.replace(/\./g, ' › '),
          })),
        },
        { orgId: organizationId },
      );
      const allowed = new Set(candidates.map((c) => c.slug));
      if (output.categoryIds.length > 0 && !output.categoryIds.some((id) => allowed.has(id))) {
        this.logger.warn(
          { answered: output.categoryIds.length },
          'search intent model ignored its candidates',
        );
        return fallback();
      }
      return { output, usedFallback: false };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn({ code: error.code }, 'search intent model unavailable; rule-based reading');
      return fallback();
    }
  }

  /** Resolves the location phrase; an ambiguous place becomes the clarification question. */
  private async locate(
    intent: SearchIntent,
    locale: Locale,
    country: string | null,
    organizationId: string,
  ): Promise<ParseSearchIntentResponse> {
    if (!intent.location) return { intent, resolvedArea: null, alternatives: [] };
    let resolution: LocationResolution | null = null;
    try {
      resolution = await this.resolver.resolve(intent.location.text, {
        locale,
        countryHint: country,
        organizationId,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn({ code: error.code }, 'search intent location not resolved');
    }
    const warnings = [...intent.warnings];
    const found: readonly AreaCandidate[] = resolution?.candidates ?? [];
    if (found.length === 0) warnings.push(SEARCH_INTENT_WARNINGS.locationNotFound);
    if (resolution?.notice) warnings.push(SEARCH_INTENT_WARNINGS.locationIncomplete);
    const chosen = resolution?.chosen != null ? (found[resolution.chosen] ?? null) : null;
    const needsClarification =
      intent.needsClarification ??
      (!chosen && found.length > 1
        ? {
            question: clarifyQuestion(intent.language, intent.location.text),
            options: found.slice(0, CLARIFY_OPTIONS).map((c) => c.label.slice(0, 200)),
          }
        : null);
    return {
      intent: {
        ...intent,
        location: { text: intent.location.text, resolution },
        needsClarification,
        warnings: warnings.slice(0, 10),
      },
      resolvedArea: chosen,
      alternatives: found.filter((c) => c !== chosen),
    };
  }
}

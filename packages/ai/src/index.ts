// @bf/ai — the only package that calls model providers (ADR-0011). See README.md.
export { embeddingCacheKey, responseCacheKey, stableStringify } from './cache.ts';
export {
  addUsage,
  costUsd,
  type ModelPricing,
  ModelPricingSchema,
  type TokenUsage,
  ZERO_USAGE,
} from './cost.ts';
export {
  AI_TIERS,
  type AiTask,
  type AiTier,
  defineTask,
  getTask,
  type ObjectTask,
  registeredTasks,
  type TextTask,
  type VisionTask,
} from './define-task.ts';
export {
  AiOutputInvalidError,
  AiProviderNotConfiguredError,
  AiProviderUnavailableError,
  PromptError,
} from './errors.ts';
export {
  type AgentEvent,
  type AgentOptions,
  type AgentRun,
  type AgentTurn,
  type AiContext,
  type AiGateway,
  type AiGatewayOptions,
  type AiResult,
  type AiStream,
  createAiGateway,
  type EmbedOptions,
  type EmbedResult,
  type ModelFactory,
  PROVIDER_SECRETS,
  providerModels,
} from './gateway.ts';
export type { AiCache, BudgetGuard, BudgetState, KeyResolver, LlmCall, LlmCallRecorder } from './ports.ts';
export {
  DEFAULT_PROMPTS_DIR,
  loadPromptRegistry,
  type Prompt,
  type PromptRegistry,
  parsePrompt,
} from './prompts/registry.ts';
export { renderTemplate } from './prompts/render.ts';
export { DEFAULT_RESILIENCE, isRetryableProviderError, type ResilienceConfig } from './resilience.ts';
export {
  type AiProvider,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TIERS,
  type ModelRef,
  parseModelRef,
  type RoutingConfig,
  routeFor,
} from './routing.ts';
export {
  AssetsAnalyzeImage,
  AssetsAnalyzeImageInput,
  AssetsAnalyzeImageOutput,
} from './tasks/assets-analyze-image.ts';
export { DemoExtractBusinessFacts } from './tasks/demo-extract-business-facts.ts';
export {
  EXTRACTABLE_FACT_KINDS,
  type ExtractableFactKind,
  ExtractSiteFactsInput,
  ExtractSiteFactsOutput,
  GenerationExtractSiteFacts,
  SITE_FACT_EVIDENCE_MAX_WORDS,
  SITE_FACT_PAGE_BUDGET,
  SITE_FACT_PAGES_PER_CALL,
  type SiteFactCandidate,
} from './tasks/generation-extract-site-facts.ts';
export {
  GenerationSiteCopy,
  SiteCopyInput,
  SiteCopyOutput,
} from './tasks/generation-site-copy.ts';
export {
  GenerationSiteJudge,
  SITE_JUDGE_CRITERIA,
  SiteJudgeInput,
  SiteJudgeOutput,
} from './tasks/generation-site-judge.ts';
export {
  GenerationSitePlan,
  SitePlanInput,
  SitePlanOutput,
} from './tasks/generation-site-plan.ts';
export {
  EmailDraftInput,
  EmailDraftOutput,
  OutreachEmailDraft,
} from './tasks/outreach-email-draft.ts';
export {
  QualityUnsupportedClaims,
  UnsupportedClaimsInput,
  UnsupportedClaimsOutput,
} from './tasks/quality-unsupported-claims.ts';
export {
  QualityVisualCritic,
  VISUAL_CRITERIA,
  VISUAL_FIXES,
  type VisualCriterion,
  VisualCriticInput,
  VisualCriticOutput,
} from './tasks/quality-visual-critic.ts';
export {
  ExtractPainSignalsInput,
  ExtractPainSignalsOutput,
  REVIEW_TEXT_BUDGET,
  REVIEWS_PER_CALL,
  ReviewsExtractPainSignals,
} from './tasks/reviews-extract-pain-signals.ts';
export {
  ParseSearchIntentInput,
  ParseSearchIntentOutput,
  SearchParseIntent,
} from './tasks/search-parse-intent.ts';
export { SiteEditAgentInput, SitesEditAgent } from './tasks/sites-edit-agent.ts';
export {
  ClassifyBusinessInput,
  ClassifyBusinessOutput,
  NO_CATEGORY,
  TaxonomyClassifyBusiness,
} from './tasks/taxonomy-classify-business.ts';
export {
  REJECT_REASONS,
  type RejectReason,
  type SiteFactVerification,
  type SitePageText,
  type VerifiedSiteFact,
  verifySiteFactCandidates,
} from './tasks/verify-site-facts.ts';
export {
  WebsiteVisionGrade,
  WebsiteVisionGradeInput,
  WebsiteVisionGradeOutput,
} from './tasks/website-vision-grade.ts';
export { registerAiTelemetry } from './telemetry.ts';
export { sanitizeUntrusted, UNTRUSTED_DATA_RULES, type UntrustedOptions, untrusted } from './untrusted.ts';
export { type AiImage, DEFAULT_MAX_IMAGE_DIMENSION } from './vision.ts';

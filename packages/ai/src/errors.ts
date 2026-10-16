import { ConflictError, DomainError, ExternalServiceError } from '@bf/contracts';

/** The workspace (and the deployment) has no key for a provider the task needs. */
export class AiProviderNotConfiguredError extends ConflictError {
  readonly provider: string;
  /** Registry key to set in Settings → Integrations (`SECRET_DEFINITIONS`). */
  readonly secretName: string;

  constructor(provider: string, secretName: string) {
    super(`No ${provider} API key is configured. Add "${secretName}" in Settings → Integrations.`, {
      details: { reason: 'AI_PROVIDER_NOT_CONFIGURED', secretName },
    });
    this.provider = provider;
    this.secretName = secretName;
  }
}

/** The model's answer did not match the task's schema, even after one repair round. */
export class AiOutputInvalidError extends ExternalServiceError {
  /** Tokens billed for the failed attempts (they count toward the ledger and budgets). */
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | undefined;
  /** The model that produced the invalid output. */
  model: { provider: 'anthropic' | 'openai'; model: string } | undefined;

  constructor(task: string, cause?: unknown) {
    super('llm', `${task}: the model returned invalid output`, {
      cause,
      details: { reason: 'AI_OUTPUT_INVALID', task },
    });
    this.usage = undefined;
    this.model = undefined;
  }
}

/** Every provider in the task's chain failed (outage, rate limit, open circuit). */
export class AiProviderUnavailableError extends ExternalServiceError {
  constructor(task: string, cause?: unknown) {
    super('llm', `${task}: no model provider is available`, {
      cause,
      details: { reason: 'AI_UNAVAILABLE', task },
    });
  }
}

/** A prompt file or its rendering is wrong: a programming error, caught by tests. */
export class PromptError extends DomainError {
  readonly code = 'INTERNAL';
}

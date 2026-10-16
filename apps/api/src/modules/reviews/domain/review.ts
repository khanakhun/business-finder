import type { PainSignalTag, ReviewSource } from '@bf/contracts';

// Review mining types (BF-029). Review text only exists in memory between a source and the classifier: it is never
// persisted (no source allows `store_text` yet) and reviewer identities never leave the source adapter.

/** One review as a source returns it, before personal details are removed. */
export interface SourceReview {
  readonly text: string;
  readonly rating?: number;
  /** BCP-47 language the source reports, if any. */
  readonly language?: string;
  /** What the source says about an owner reply; null when it does not tell. */
  readonly ownerResponded: boolean | null;
  /**
   * Names the source attaches to the review (its author, the owner signing a reply): used only to remove them from
   * the text, never stored, logged or sent to a model.
   */
  readonly knownNames: readonly string[];
}

/** What one source returned for a business. */
export interface ReviewBatch {
  readonly source: ReviewSource;
  readonly reviews: readonly SourceReview[];
  /** The source's own rating summary, if it gives one. */
  readonly rating: { readonly avg: number; readonly count: number } | null;
  readonly fetchedAt: Date;
  /** What fetching cost (paid API calls). */
  readonly costUsd: number;
}

/** A review ready for the classifier: personal details replaced by placeholders. */
export interface PreparedReview {
  readonly text: string;
  readonly rating?: number;
  readonly language: string;
  readonly ownerResponded: boolean | null;
}

/** The classifier's verdict on one review. */
export interface ClassifiedReview {
  readonly tags: readonly PainSignalTag[];
  readonly sentiment: number;
  readonly mentionsOwnerResponse: boolean;
  /** A checked paraphrase (≤ 20 words, not a quote, no personal details), or null. */
  readonly evidence: string | null;
  readonly language: string;
  readonly ownerResponded: boolean | null;
}

import type { Provenance as ProvenanceShape, SourceProvider } from '@bf/contracts';
import { InvalidValueError } from '../errors.ts';

/** Where one field value came from (ARCHITECTURE.md §6.2). */
export interface ProvenanceInput {
  readonly source: SourceProvider;
  readonly sourceRef: string | null;
  readonly confidence: number;
  readonly observedAt: Date;
}

export function provenanceOf(value: unknown, input: ProvenanceInput): ProvenanceShape {
  if (!(input.confidence >= 0 && input.confidence <= 1)) {
    throw new InvalidValueError('provenance', 'Confidence must be between 0 and 1.');
  }
  if (Number.isNaN(input.observedAt.getTime()))
    throw new InvalidValueError('provenance', 'Invalid observation time.');
  return {
    value,
    source: input.source,
    sourceRef: input.sourceRef,
    confidence: input.confidence,
    observedAt: input.observedAt.toISOString(),
  };
}

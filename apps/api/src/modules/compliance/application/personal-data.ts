import { Injectable } from '@nestjs/common';

// The personal-data registry (BF-055, Registry/Plugin): every module that stores personal data registers a provider
// that can find, export, erase (delete or anonymize) and optionally restrict what it holds about a data subject.
// BF-052 and BF-054 register their outbound and inbound providers the same way.

export interface DataSubjectQuery {
  readonly organizationId: string;
  /** Normalized (lowercase) when present. */
  readonly email?: string | undefined;
  /** E.164 digits with their + when it parses; else as given. */
  readonly phone?: string | undefined;
  readonly name?: string | undefined;
  readonly businessId?: string | undefined;
  /** The keyed hash of the email (matches rows that keep only the hash). */
  readonly emailHash?: string | undefined;
}

export interface PersonalDataRecordRef {
  readonly id: string;
  /** Short and redacted: shown to the person handling the request (no full values). */
  readonly summary: string;
}

export interface ExportChunk {
  /** File name inside the export (without extension). */
  readonly name: string;
  readonly rows: Record<string, unknown>[];
}

export interface ErasureResult {
  readonly erased: number;
  /** Records a person must review (free text mentioning the subject). */
  readonly manual: number;
}

export interface PersonalDataProvider {
  readonly id: string;
  readonly categories: readonly string[];
  /** Results need a person's review rather than automatic erasure. */
  readonly manualReview?: boolean;
  find(subject: DataSubjectQuery): Promise<PersonalDataRecordRef[]>;
  export(subject: DataSubjectQuery, refs: readonly PersonalDataRecordRef[]): Promise<ExportChunk[]>;
  erase(
    subject: DataSubjectQuery,
    refs: readonly PersonalDataRecordRef[],
    mode: 'delete' | 'anonymize',
  ): Promise<ErasureResult>;
  restrict?(subject: DataSubjectQuery, refs: readonly PersonalDataRecordRef[], on: boolean): Promise<void>;
}

@Injectable()
export class PersonalDataRegistry {
  private readonly providers = new Map<string, PersonalDataProvider>();

  register(provider: PersonalDataProvider): void {
    if (this.providers.has(provider.id)) return;
    this.providers.set(provider.id, provider);
  }

  list(): PersonalDataProvider[] {
    return [...this.providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

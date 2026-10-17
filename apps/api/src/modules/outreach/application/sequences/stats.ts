import { NotFoundError, type SequenceStats } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { wilson } from '../../domain/sequences/variant-assigner.ts';
import type { DraftActor } from '../drafting/drafts.service.ts';
import { SEQUENCE_REPOSITORY, type SequenceRepository } from './ports.ts';

// Sequence statistics (BF-053): per step and variant, emails sent and the share replied (and positively, from the
// triage), bounced, unsubscribed, and whose preview was viewed — each with a Wilson 95% interval and an "insufficient
// data" marker below 30 sends. No automatic winner: people decide.

const MIN_N = 30;
const SENT = new Set(['sent', 'replied', 'bounced']);

@Injectable()
export class SequenceStatsService {
  constructor(@Inject(SEQUENCE_REPOSITORY) private readonly repository: SequenceRepository) {}

  async stats(actor: DraftActor, sequenceId: string): Promise<SequenceStats> {
    const sequence = await this.repository.get(actor.organizationId, sequenceId);
    if (!sequence) throw new NotFoundError('Sequence', sequenceId);
    const rows = (await this.repository.statsRows(sequenceId)).filter((row) => SENT.has(row.status));
    const byStep = new Map<string, Map<string, typeof rows>>();
    for (const row of rows) {
      const step = byStep.get(row.stepId) ?? new Map<string, typeof rows>();
      step.set(row.variantId, [...(step.get(row.variantId) ?? []), row]);
      byStep.set(row.stepId, step);
    }
    const rate = (successes: number, n: number) => ({ n, ...wilson(successes, n), insufficient: n < MIN_N });
    return {
      sequenceId,
      steps: [...byStep.entries()].map(([stepId, variants]) => ({
        stepId,
        variants: [...variants.entries()].map(([variantId, items]) => {
          const n = items.length;
          const count = (predicate: (row: (typeof items)[number]) => boolean) =>
            items.filter(predicate).length;
          return {
            variantId,
            sent: n,
            replies: rate(
              count((row) => row.replied),
              n,
            ),
            positive: rate(
              count((row) => row.positive),
              n,
            ),
            bounces: rate(
              count((row) => row.status === 'bounced'),
              n,
            ),
            unsubscribes: rate(
              count((row) => row.unsubscribed),
              n,
            ),
            previewViews: rate(
              count((row) => row.viewed),
              n,
            ),
          };
        }),
      })),
    };
  }
}

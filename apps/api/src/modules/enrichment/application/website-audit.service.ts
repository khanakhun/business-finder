import type { Clock, PsiResult, VisionGrade } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { assessWebsite } from '../domain/website-audit.ts';
import {
  WEBSITE_AUDITS,
  type WebsiteAuditRecord,
  type WebsiteAuditRepository,
  type WebsiteSnapshotRecord,
} from './ports.ts';

/**
 * The website audit of a snapshot (BF-030), written part by part: `psi` and `vision_audit` each record what they
 * measured, and every write recomputes findings, quality score and status from all the parts there (pure rules), so
 * the audit is complete whatever order the steps finish in. A part that could not be measured (`null`) keeps what an
 * earlier run of the same snapshot measured.
 */
@Injectable()
export class WebsiteAuditService {
  constructor(
    @Inject(WEBSITE_AUDITS) private readonly audits: WebsiteAuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Transactional()
  async record(
    snapshot: WebsiteSnapshotRecord,
    part: { readonly psi?: PsiResult | null; readonly vision?: VisionGrade | null },
  ): Promise<WebsiteAuditRecord> {
    const current = await this.audits.lockForSnapshot(snapshot.businessId, snapshot.id);
    // Per strategy: a re-check that measured only mobile keeps the desktop result of the same crawl.
    const psi =
      part.psi || current?.psi
        ? {
            mobile: part.psi?.mobile ?? current?.psi?.mobile ?? null,
            desktop: part.psi?.desktop ?? current?.psi?.desktop ?? null,
          }
        : null;
    const vision = part.vision ?? current?.vision ?? null;
    const business = await this.audits.businessFacts(snapshot.businessId);
    const outcome = assessWebsite({
      snapshot: snapshot.intel,
      psi,
      vision,
      business,
      now: this.clock.now(),
    });
    return this.audits.save({
      businessId: snapshot.businessId,
      snapshotId: snapshot.id,
      psi,
      vision,
      ...outcome,
    });
  }

  /** The business's primary category label (vision context). */
  async categoryLabel(businessId: string): Promise<string | null> {
    return (await this.audits.businessFacts(businessId)).categoryLabel;
  }

  latest(businessId: string): Promise<WebsiteAuditRecord | undefined> {
    return this.audits.latest(businessId);
  }
}

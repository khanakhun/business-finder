import {
  type CategoryMapping,
  ForbiddenError,
  type Locale,
  NotFoundError,
  type ReviewCategoryMappingRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../../platform/db/transactional.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { TAXONOMY_REPOSITORY, type TaxonomyRepository } from './ports.ts';
import { toCategoryMapping } from './taxonomy.queries.ts';
import { TaxonomyCache } from './taxonomy-cache.ts';

/**
 * A reviewer approves, reassigns or rejects a provider mapping (`settings:manage`). The decision becomes a
 * `human` mapping: seeds never overwrite it and the classifier ranks it first.
 */
@Injectable()
export class ReviewCategoryMappingCommand {
  constructor(
    @Inject(TAXONOMY_REPOSITORY) private readonly repository: TaxonomyRepository,
    private readonly cache: TaxonomyCache,
    private readonly audit: AuditLogger,
  ) {}

  async execute(
    auth: AuthContext,
    id: string,
    request: ReviewCategoryMappingRequest,
    locale: Locale,
  ): Promise<CategoryMapping> {
    const record = await this.review(auth, id, request);
    this.cache.invalidate();
    return toCategoryMapping(record, await this.cache.get(), locale, true);
  }

  @Transactional()
  private async review(auth: AuthContext, id: string, request: ReviewCategoryMappingRequest) {
    // DECISION(BF-015): mappings are shared by every workspace, so `settings:manage` alone is not enough.
    if (!auth.operator) {
      throw new ForbiddenError(
        'Category mappings are shared by every workspace: platform operators review them.',
      );
    }
    const mapping = await this.repository.getMapping(id);
    if (!mapping) throw new NotFoundError('CategoryMapping', id);
    let categoryId = mapping.categoryId;
    if (request.action === 'approve' && !(await this.cache.get()).byId.has(categoryId)) {
      throw new ValidationError('The proposed category is no longer active; reassign the mapping instead.', [
        { path: ['action'], message: 'Category inactive' },
      ]);
    }
    if (request.action === 'reassign') {
      const snapshot = await this.cache.get();
      if (!request.categoryId || !snapshot.byId.has(request.categoryId)) {
        throw new ValidationError('Unknown or inactive category.', [
          { path: ['categoryId'], message: 'Unknown or inactive category' },
        ]);
      }
      categoryId = request.categoryId;
    }
    const updated = await this.repository.reviewMapping(id, {
      status: request.action === 'reject' ? 'rejected' : 'active',
      categoryId,
      // A reviewed mapping is certain: the classifier accepts it without asking the model.
      confidence: request.action === 'reject' ? mapping.confidence : 1,
      reviewedBy: auth.userId,
    });
    if (!updated) throw new NotFoundError('CategoryMapping', id);
    // Platform data reviewed from a workspace: audited with that workspace.
    await this.audit.record({
      action: 'taxonomy.mapping_reviewed',
      entityType: 'category_mapping',
      entityId: id,
      metadata: {
        action: request.action,
        provider: mapping.provider,
        previousStatus: mapping.status,
        previousOrigin: mapping.origin,
        from: mapping.categoryId,
        to: categoryId,
      },
    });
    return updated;
  }
}

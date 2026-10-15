import {
  type CategoryMapping,
  type CategoryMappingPage,
  CategoryMappingPageSchema,
  CategoryMappingQuerySchema,
  CategoryMappingSchema,
  CategorySearchQuerySchema,
  type CategorySearchResult,
  CategorySearchResultSchema,
  type CategoryTree,
  CategoryTreeQuerySchema,
  CategoryTreeSchema,
  ReviewCategoryMappingRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ReviewCategoryMappingCommand } from '../../application/taxonomy/taxonomy.commands.ts';
import {
  GetCategoryTreeQuery,
  ListCategoryMappingsQuery,
  SearchCategoriesQuery,
} from '../../application/taxonomy/taxonomy.queries.ts';

class TreeQueryDto extends zodDto(CategoryTreeQuerySchema) {}
class SearchQueryDto extends zodDto(CategorySearchQuerySchema) {}
class MappingQueryDto extends zodDto(CategoryMappingQuerySchema) {}
class ReviewMappingBody extends zodDto(ReviewCategoryMappingRequestSchema) {}

/** The category taxonomy (BF-015): tree, typeahead and the review queue of provider mappings. */
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly tree: GetCategoryTreeQuery,
    private readonly search: SearchCategoriesQuery,
    private readonly mappings: ListCategoryMappingsQuery,
    private readonly review: ReviewCategoryMappingCommand,
  ) {}

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'The category tree with labels in the requested locale',
    operationId: 'getCategoryTree',
    query: TreeQueryDto,
    response: { status: 200, schema: CategoryTreeSchema },
    errors: [401, 403],
  })
  index(@Query() query: TreeQueryDto): Promise<CategoryTree> {
    return this.tree.execute(query.locale);
  }

  @Get('search')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Typeahead over category labels and synonyms (EN/FR, accent-insensitive)',
    operationId: 'searchCategories',
    query: SearchQueryDto,
    response: { status: 200, schema: CategorySearchResultSchema },
    errors: [401, 403],
  })
  find(@Query() query: SearchQueryDto): Promise<CategorySearchResult> {
    return this.search.execute(query);
  }

  @Get('mappings')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Provider category mappings by status (default: LLM proposals awaiting review)',
    operationId: 'listCategoryMappings',
    query: MappingQueryDto,
    response: { status: 200, schema: CategoryMappingPageSchema },
    errors: [401, 403],
  })
  listMappings(@Ctx() auth: AuthContext, @Query() query: MappingQueryDto): Promise<CategoryMappingPage> {
    return this.mappings.execute(auth, query);
  }

  @Patch('mappings/:id')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Approve, reassign or reject a provider mapping (platform operators)',
    operationId: 'reviewCategoryMapping',
    query: TreeQueryDto,
    body: ReviewMappingBody,
    response: { status: 200, schema: CategoryMappingSchema },
    errors: [400, 401, 403, 404],
  })
  reviewMapping(
    @Ctx() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: TreeQueryDto,
    @Body() body: ReviewMappingBody,
  ): Promise<CategoryMapping> {
    return this.review.execute(auth, id, body, query.locale);
  }
}

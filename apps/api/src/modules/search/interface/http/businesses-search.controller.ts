import {
  type BusinessFacets,
  BusinessFacetsSchema,
  BusinessFiltersSchema,
  type BusinessSearchPage,
  BusinessSearchPageSchema,
  BusinessSearchQuerySchema,
} from '@bf/contracts';
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { BusinessFacetsQuery, SearchBusinessesQuery } from '../../application/listing.queries.ts';

class SearchQueryDto extends zodDto(BusinessSearchQuerySchema) {}
class FiltersQueryDto extends zodDto(BusinessFiltersSchema) {}

/** The workspace's listing (BF-022): filters, hybrid text ranking, sorts, cursor pages and facets. */
@ApiTags('businesses')
@Controller('businesses')
export class BusinessesSearchController {
  constructor(
    private readonly search: SearchBusinessesQuery,
    private readonly facetsQuery: BusinessFacetsQuery,
  ) {}

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Businesses the workspace tracks: filters, free text (hybrid ranking), sorts and cursor pages',
    operationId: 'listBusinesses',
    query: SearchQueryDto,
    response: { status: 200, schema: BusinessSearchPageSchema },
    errors: [401, 403, 404],
  })
  index(@Ctx() auth: AuthContext, @Query() query: SearchQueryDto): Promise<BusinessSearchPage> {
    return this.search.execute(auth, query);
  }

  @Get('facets')
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'Counts per category, status, tier, website, email, rating band and locality under the same filters',
    operationId: 'listBusinessFacets',
    query: FiltersQueryDto,
    response: { status: 200, schema: BusinessFacetsSchema },
    errors: [401, 403, 404],
  })
  facets(@Ctx() auth: AuthContext, @Query() query: FiltersQueryDto): Promise<BusinessFacets> {
    return this.facetsQuery.execute(auth, query);
  }
}

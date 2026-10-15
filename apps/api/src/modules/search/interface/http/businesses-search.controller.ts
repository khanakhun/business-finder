import { once } from 'node:events';
import {
  BusinessExportQuerySchema,
  type BusinessFacets,
  BusinessFacetsSchema,
  BusinessFiltersSchema,
  type BusinessSearchPage,
  BusinessSearchPageSchema,
  BusinessSearchQuerySchema,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LOGGER } from '../../../platform/logging/logger.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { ExportBusinesses } from '../../application/export-businesses.ts';
import { BusinessFacetsQuery, SearchBusinessesQuery } from '../../application/listing.queries.ts';

class SearchQueryDto extends zodDto(BusinessSearchQuerySchema) {}
class FiltersQueryDto extends zodDto(BusinessFiltersSchema) {}
class ExportQueryDto extends zodDto(BusinessExportQuerySchema) {}

/** The workspace's listing (BF-022): filters, hybrid text ranking, sorts, cursor pages and facets. */
@ApiTags('businesses')
@Controller('businesses')
export class BusinessesSearchController {
  constructor(
    private readonly search: SearchBusinessesQuery,
    private readonly facetsQuery: BusinessFacetsQuery,
    private readonly exporter: ExportBusinesses,
    @Inject(LOGGER) private readonly logger: Logger,
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

  @Get('export.csv')
  @RequirePermission('business:read')
  @ApiProduces('text/csv')
  @ApiRoute({
    summary: 'The listing as CSV (same filters and sort; contact columns need outreach:send; audit-logged)',
    operationId: 'exportBusinesses',
    query: ExportQueryDto,
    response: { status: 200, schema: null },
    errors: [401, 403, 404],
  })
  async export(
    @Ctx() auth: AuthContext,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const rows = this.exporter.rows(auth, query, this.exporter.fieldsFor(auth, query));
    // The first chunk (the header) comes after validation and area lookup: errors so far are still problem+json.
    const header = await rows.next();
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="businesses.csv"');
    res.setHeader('Cache-Control', 'no-store');
    // BOM: spreadsheets then read accents (Saint-Barthélemy) as UTF-8.
    res.write('\uFEFF');
    try {
      if (!header.done) res.write(header.value);
      for await (const chunk of rows) {
        if (res.destroyed) break;
        // A client that stops reading and disconnects never drains: wait for either, then stop.
        if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
      res.end();
    } catch (error) {
      this.logger.error({ err: error }, 'business export failed mid-stream');
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Client gone: closing the generator still records the audit entry.
      await rows.return(undefined);
    }
  }
}

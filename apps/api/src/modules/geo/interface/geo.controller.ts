import {
  CreateCustomAreaRequestSchema,
  type GeoAreaFeature,
  GeoAreaFeatureSchema,
  type GeoAreaList,
  GeoAreaListSchema,
  GeoAreaQuerySchema,
  type GeoAreaSummary,
  GeoAreaSummarySchema,
  LocaleSchema,
  type LocationResolution,
  LocationResolutionSchema,
  ResolveLocationQuerySchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Ctx, RequirePermission } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import {
  CreateCustomAreaCommand,
  GeoAreaQueries,
  ResolveLocationQueryHandler,
} from '../application/geo.use-cases.ts';

class ResolveQueryDto extends zodDto(ResolveLocationQuerySchema) {}
class AreaQueryDto extends zodDto(GeoAreaQuerySchema) {}
class LocaleQueryDto extends zodDto(z.object({ locale: LocaleSchema.default('en') })) {}
class CreateAreaBody extends zodDto(CreateCustomAreaRequestSchema) {}

/** Location resolution and areas (BF-017). */
@ApiTags('geo')
@Controller('geo')
export class GeoController {
  constructor(
    private readonly resolveHandler: ResolveLocationQueryHandler,
    private readonly queries: GeoAreaQueries,
    private readonly createArea: CreateCustomAreaCommand,
  ) {}

  @Get('resolve')
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'Resolve free text ("St Barth", "Gustavia", "1012", "within 3 km of Lorient") into candidate areas',
    operationId: 'resolveLocation',
    query: ResolveQueryDto,
    response: { status: 200, schema: LocationResolutionSchema },
    errors: [401, 403],
  })
  resolve(@Ctx() auth: AuthContext, @Query() query: ResolveQueryDto): Promise<LocationResolution> {
    return this.resolveHandler.execute(auth, query);
  }

  @Get('areas')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Typeahead over areas (names and aliases)',
    operationId: 'searchGeoAreas',
    query: AreaQueryDto,
    response: { status: 200, schema: GeoAreaListSchema },
    errors: [401, 403],
  })
  areas(@Ctx() auth: AuthContext, @Query() query: AreaQueryDto): Promise<GeoAreaList> {
    return this.queries.search(auth, query);
  }

  @Get('areas/:id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'An area as a GeoJSON Feature',
    operationId: 'getGeoArea',
    query: LocaleQueryDto,
    response: { status: 200, schema: GeoAreaFeatureSchema },
    errors: [400, 401, 403, 404],
  })
  area(
    @Ctx() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: LocaleQueryDto,
  ): Promise<GeoAreaFeature> {
    return this.queries.feature(auth, id, query.locale);
  }

  @Post('areas')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Save a custom area drawn on the map (visible to this workspace only)',
    operationId: 'createGeoArea',
    body: CreateAreaBody,
    response: { status: 201, schema: GeoAreaSummarySchema },
    errors: [400, 401, 403],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateAreaBody): Promise<GeoAreaSummary> {
    return this.createArea.execute(auth, body);
  }
}

import { AddSiteDomainRequestSchema, SiteDomainSchema } from '@bf/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { AllowAnonymous, Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { DomainsService } from '../../application/go-live/domains.service.ts';
import { actorOf } from './sites.controller.ts';

class AddBody extends zodDto(AddSiteDomainRequestSchema) {}
class AskQuery extends zodDto(
  z.object({ domain: z.string().max(253).optional(), token: z.string().max(200).optional() }),
) {}

const SiteDomainListSchema = z.object({ items: z.array(SiteDomainSchema) }).meta({ id: 'SiteDomainList' });

/** A live site's custom domains (BF-062): records to create, verification, removal. */
@ApiTags('sites')
@Controller('sites')
export class SiteDomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get(':id/domains')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'The site’s custom domains with the DNS records to create and the last check',
    operationId: 'listSiteDomains',
    response: { status: 200, schema: SiteDomainListSchema },
    errors: [401, 403, 404],
  })
  async list(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.domains.list(actorOf(auth), id) };
  }

  @Post(':id/domains')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Attach a domain (and its www): verification starts in the background',
    operationId: 'addSiteDomain',
    body: AddBody,
    response: { status: 201, schema: SiteDomainListSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async add(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AddBody) {
    return { items: await this.domains.add(actorOf(auth), id, body) };
  }

  @Post(':id/domains/:domainId/check')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Check a domain’s DNS now',
    operationId: 'checkSiteDomain',
    response: { status: 200, schema: SiteDomainSchema },
    errors: [401, 403, 404],
  })
  check(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    return this.domains.check(actorOf(auth), id, domainId);
  }

  @Delete(':id/domains/:domainId')
  @HttpCode(204)
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Remove a domain: it stops being served (its certificate expires on its own)',
    operationId: 'removeSiteDomain',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async remove(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domainId', ParseUUIDPipe) domainId: string,
  ) {
    await this.domains.remove(actorOf(auth), id, domainId);
  }
}

/**
 * Caddy's on-demand TLS `ask` (BF-062): 200 for a verified or active custom domain, 403 otherwise. Caddy cannot
 * send a header, so its ask URL carries a shared token; the edge proxy also never routes this path publicly.
 */
@ApiTags('sites')
@Controller('internal/domains')
export class InternalDomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get('allow')
  @AllowAnonymous()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiRoute({
    summary: 'May a certificate be issued for this domain? (Caddy on-demand TLS ask)',
    operationId: 'allowCertificateDomain',
    query: AskQuery,
    response: { status: 200, schema: null },
    errors: [403],
  })
  async allow(@Query() query: AskQuery, @Res() res: Response): Promise<void> {
    res.status((await this.domains.allow(query.domain, query.token)) ? 200 : 403).end();
  }
}

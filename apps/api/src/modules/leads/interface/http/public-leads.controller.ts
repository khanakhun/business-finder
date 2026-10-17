import {
  NotFoundError,
  PublicLeadRequestSchema,
  type PublicLeadResponse,
  PublicLeadResponseSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { getRequestContext } from '../../../platform/context/request-context.ts';
import { AllowAnonymous } from '../../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { LeadCaptureDisabledError, PublicLeads } from '../../application/public-leads.ts';
import { siteOrigin } from '../sites-origin.ts';

class LeadBody extends zodDto(PublicLeadRequestSchema) {}

export const LEAD_SITES_DOMAIN = Symbol('LeadSitesDomain');

/**
 * The renderer's lead forms (BF-048), anonymous: a proof-of-work challenge, and a claim, contact request or opt-out.
 * Always "received" (nothing tells whether the site exists). A plain form post (no JavaScript) is redirected back to
 * the page it came from on the sites domain.
 */
@ApiTags('leads')
@Controller('public/sites')
export class PublicLeadsController {
  constructor(
    private readonly leads: PublicLeads,
    @Inject(LEAD_SITES_DOMAIN) private readonly sitesDomain: string,
  ) {}

  @Get('altcha-challenge')
  @AllowAnonymous()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiRoute({
    summary: 'A proof-of-work challenge for a preview site’s form (ALTCHA, self-hosted)',
    operationId: 'getLeadChallenge',
    response: { status: 200, schema: null },
    errors: [404, 429],
  })
  async challenge(@Query('siteToken') siteToken: string | undefined): Promise<Record<string, unknown>> {
    try {
      return await this.leads.challenge(String(siteToken ?? '').slice(0, 200));
    } catch (error) {
      if (error instanceof LeadCaptureDisabledError) throw new NotFoundError('LeadCapture', 'disabled');
      throw error;
    }
  }

  @Post('leads')
  @HttpCode(200)
  @AllowAnonymous()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiRoute({
    summary: 'A claim, contact request or opt-out from a preview site (anonymous; anti-spam; no IP stored)',
    operationId: 'submitSiteLead',
    body: LeadBody,
    response: { status: 200, schema: PublicLeadResponseSchema },
    errors: [400, 404, 422, 429],
  })
  async submit(
    @Body() body: LeadBody,
    @Headers('content-type') contentType: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicLeadResponse | undefined> {
    let result: PublicLeadResponse;
    try {
      result = await this.leads.submit(body, { ip: getRequestContext()?.ip });
    } catch (error) {
      if (error instanceof LeadCaptureDisabledError) throw new NotFoundError('LeadCapture', 'disabled');
      throw error;
    }
    // A plain HTML form: back to the page on the site, with the outcome.
    if (contentType?.startsWith('application/x-www-form-urlencoded')) {
      const origin = siteOrigin(referer, this.sitesDomain);
      if (origin) {
        const next = body.next ?? '/';
        res.redirect(303, `${origin}${next}${next.includes('?') ? '&' : '?'}sent=${result.messageKey}`);
        return undefined;
      }
    }
    return result;
  }
}

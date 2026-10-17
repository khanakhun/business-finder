import { NotFoundError, PublicDsrIntakeSchema } from '@bf/contracts';
import { Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { getRequestContext } from '../../../platform/context/request-context.ts';
import { AllowAnonymous } from '../../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { PublicDsrIntake } from '../../application/public-dsr-intake.ts';
import { LeadCaptureDisabledError } from '../../application/public-leads.ts';
import { siteOrigin } from '../sites-origin.ts';
import { LEAD_SITES_DOMAIN } from './public-leads.controller.ts';

class IntakeBody extends zodDto(PublicDsrIntakeSchema) {}

/** The privacy page's "exercise your rights" form (BF-055): JSON, or a plain form post that returns to the page. */
@ApiTags('leads')
@Controller('public/sites')
export class PublicDsrController {
  constructor(
    private readonly intake: PublicDsrIntake,
    @Inject(LEAD_SITES_DOMAIN) private readonly sitesDomain: string,
  ) {}

  @Post('dsr')
  @HttpCode(200)
  @AllowAnonymous()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiRoute({
    summary: 'A data-subject request from a preview’s privacy page (anonymous; always "received")',
    operationId: 'submitPublicDsr',
    body: IntakeBody,
    response: { status: 200, schema: null },
    errors: [400, 404, 429],
  })
  async submit(
    @Body() body: IntakeBody,
    @Headers('content-type') contentType: string | undefined,
    @Headers('referer') referer: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ received: true } | undefined> {
    let result: { received: true };
    try {
      result = await this.intake.submit(body, { ip: getRequestContext()?.ip });
    } catch (error) {
      if (error instanceof LeadCaptureDisabledError) throw new NotFoundError('LeadCapture', 'disabled');
      throw error;
    }
    if (contentType?.startsWith('application/x-www-form-urlencoded')) {
      const origin = siteOrigin(referer, this.sitesDomain);
      if (origin) {
        res.redirect(303, `${origin}/privacy?sent=dsr`);
        return undefined;
      }
    }
    return result;
  }
}

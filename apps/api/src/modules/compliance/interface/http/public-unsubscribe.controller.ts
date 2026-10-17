import { UNSUBSCRIBE_CHOICES, type UnsubscribeChoice } from '@bf/contracts';
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AllowAnonymous } from '../../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { UnsubscribeService } from '../../application/unsubscribe.service.ts';
import { pageLang, renderDone, renderForm, renderUnknown } from './unsubscribe-page.ts';

// Public unsubscribe routes (BF-055): no auth, no cookies, rate-limited; answers never reveal whether a token exists.

/** RFC 8058 one-click: `POST <List-Unsubscribe URL>` with `List-Unsubscribe=One-Click` (form or multipart). */
@ApiTags('unsubscribe')
@Controller('public/unsubscribe')
export class PublicUnsubscribeController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  @Post(':token')
  @HttpCode(200)
  @AllowAnonymous()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @ApiRoute({
    summary: 'RFC 8058 one-click unsubscribe (anonymous; idempotent; always 200)',
    operationId: 'oneClickUnsubscribe',
    response: { status: 200, schema: null },
    errors: [429],
  })
  async oneClick(@Param('token') token: string): Promise<{ ok: true }> {
    // DECISION(BF-055): any POST to the token URL counts (mail providers send `List-Unsubscribe=One-Click`, scanners
    // never POST); the body is not required, so a multipart post works without a multipart parser.
    await this.unsubscribe.oneClick(token);
    return { ok: true };
  }
}

const choicesOf = (body: unknown): UnsubscribeChoice[] => {
  const raw = (body as { choice?: unknown } | undefined)?.choice;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter((value): value is UnsubscribeChoice =>
    UNSUBSCRIBE_CHOICES.includes(value as UnsubscribeChoice),
  );
};

/** The human page at `/u/:token` (outside `/v1`): GET shows the choices, POST applies them. */
@Controller('u')
export class UnsubscribePageController {
  constructor(private readonly unsubscribe: UnsubscribeService) {}

  private send(res: Response, status: number, html: string) {
    res
      .status(status)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('X-Robots-Tag', 'noindex, nofollow')
      .setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      )
      .send(html);
  }

  @Get(':token')
  @AllowAnonymous()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async show(@Param('token') token: string, @Query('lang') lang: string | undefined, @Res() res: Response) {
    const model = await this.unsubscribe.page(token);
    if (!model) return this.send(res, 200, renderUnknown(pageLang(lang, 'en')));
    return this.send(res, 200, renderForm(token, pageLang(lang, model.locale), model));
  }

  @Post(':token')
  @AllowAnonymous()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiExcludeEndpoint()
  async confirm(
    @Param('token') token: string,
    @Query('lang') lang: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const model = await this.unsubscribe.confirm(token, choicesOf(body));
    if (!model) return this.send(res, 200, renderUnknown(pageLang(lang, 'en')));
    return this.send(res, 200, renderDone(pageLang(lang, model.locale), model));
  }
}

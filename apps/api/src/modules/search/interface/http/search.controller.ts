import {
  ParseSearchIntentRequestSchema,
  type ParseSearchIntentResponse,
  ParseSearchIntentResponseSchema,
} from '@bf/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { SearchIntentService } from '../../application/search-intent.service.ts';

class ParseIntentBody extends zodDto(ParseSearchIntentRequestSchema) {}

/** Natural-language search (BF-021). */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly intents: SearchIntentService) {}

  @Post('intent')
  @HttpCode(200)
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Turn a prompt ("cafés à Gustavia sans site web") into a structured, editable search intent',
    operationId: 'parseSearchIntent',
    body: ParseIntentBody,
    response: { status: 200, schema: ParseSearchIntentResponseSchema },
    errors: [400, 401, 403, 422],
  })
  parse(@Ctx() auth: AuthContext, @Body() body: ParseIntentBody): Promise<ParseSearchIntentResponse> {
    return this.intents.parse(auth, body);
  }
}

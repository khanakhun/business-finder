import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';
import { APP_ENV, type AppEnv } from '../config/app-env.ts';
import { RESPONSE_SCHEMA } from './api-route.decorator.ts';

/** A handler returned a body that does not match its documented schema (contract drift). */
export class ResponseContractError extends Error {
  constructor(route: string, issues: string) {
    super(`Response of ${route} does not match its schema: ${issues}`);
    this.name = 'ResponseContractError';
  }
}

/**
 * Outside production, checks every response body against the schema declared in `@ApiRoute` (ARCHITECTURE §5.3)
 * so drift between code and contract fails tests instead of reaching clients.
 */
@Injectable()
export class ResponseValidationInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<{ schema: z.ZodType | null } | undefined>(
      RESPONSE_SCHEMA,
      context.getHandler(),
    );
    if (this.env.NODE_ENV === 'production' || !spec?.schema) return next.handle();
    const schema = spec.schema;
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    return next.handle().pipe(
      map((body: unknown) => {
        const result = schema.safeParse(body);
        if (!result.success) throw new ResponseContractError(route, result.error.message);
        return body;
      }),
    );
  }
}

import { ProblemDetailsSchema } from '@bf/contracts';
import { applyDecorators, HttpCode, SetMetadata } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { z } from 'zod';
import { PROBLEM_CONTENT_TYPE } from '../errors/problem-details.filter.ts';
import { type SchemaObject, schemaObject } from '../openapi/schema-registry.ts';
import { type ZodDtoClass, zodSchemaOf } from './zod-dto.ts';

export const RESPONSE_SCHEMA = Symbol('RESPONSE_SCHEMA');

type SchemaOrDto = z.ZodType | ZodDtoClass;
const asSchema = (value: SchemaOrDto): z.ZodType => zodSchemaOf(value) ?? (value as z.ZodType);

export interface ApiRouteSpec {
  readonly summary: string;
  readonly operationId?: string;
  readonly body?: SchemaOrDto;
  /** Object schema; each property is documented as a query parameter. */
  readonly query?: SchemaOrDto;
  /** Success status and body schema (`null` for no body). */
  readonly response: { readonly status: number; readonly schema: z.ZodType | null };
  /** Error statuses this route can return (all as problem+json). 422 is added when there is a body or query. */
  readonly errors?: readonly number[];
}

/**
 * Documents a route in OpenAPI from Zod schemas, sets its success status, and registers the response schema for
 * `ResponseValidationInterceptor`. Request validation itself comes from `zodDto()` parameter types.
 */
export function ApiRoute(spec: ApiRouteSpec): MethodDecorator {
  const decorators: Array<MethodDecorator | ClassDecorator> = [
    ApiOperation({ summary: spec.summary, ...(spec.operationId ? { operationId: spec.operationId } : {}) }),
    HttpCode(spec.response.status),
    SetMetadata(RESPONSE_SCHEMA, spec.response),
    ApiResponse(
      spec.response.schema
        ? {
            status: spec.response.status,
            description: 'Success',
            schema: schemaObject(spec.response.schema, 'output'),
          }
        : { status: spec.response.status, description: 'Success' },
    ),
  ];
  if (spec.body) decorators.push(ApiBody({ schema: schemaObject(asSchema(spec.body), 'input') }));
  if (spec.query) {
    const json = schemaObject(asSchema(spec.query), 'input') as {
      properties?: Record<string, SchemaObject>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(json.properties ?? {})) {
      decorators.push(ApiQuery({ name, required: json.required?.includes(name) ?? false, schema }));
    }
  }
  const errors = new Set(spec.errors ?? []);
  if (spec.body || spec.query) errors.add(422);
  errors.add(500);
  const problem = schemaObject(ProblemDetailsSchema, 'output');
  for (const status of [...errors].sort()) {
    decorators.push(
      ApiResponse({
        status,
        description: 'Problem details (RFC 9457)',
        content: { [PROBLEM_CONTENT_TYPE]: { schema: problem } },
      }),
    );
  }
  return applyDecorators(...decorators);
}

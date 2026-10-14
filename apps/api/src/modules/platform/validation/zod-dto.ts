import type { z } from 'zod';

/** A class carrying a Zod schema: Nest passes classes as param metatypes, so the pipe can find the schema. */
export interface ZodDtoClass<S extends z.ZodType = z.ZodType> {
  new (): z.output<S>;
  readonly zodSchema: S;
}

/**
 * Turns a `@bf/contracts` schema into a DTO class for controller parameters:
 *
 * ```ts
 * class PingJobsBody extends zodDto(PingJobsRequestSchema) {}
 * create(@Body() body: PingJobsBody) { … }   // validated by ZodValidationPipe, typed as the schema output
 * ```
 */
export function zodDto<S extends z.ZodType>(schema: S): ZodDtoClass<S> {
  class ZodDto {
    static readonly zodSchema = schema;
  }
  // Safe: instances are never constructed; the pipe replaces the value with the schema's parsed output.
  return ZodDto as unknown as ZodDtoClass<S>;
}

export function zodSchemaOf(metatype: unknown): z.ZodType | undefined {
  if (typeof metatype !== 'function') return undefined;
  const schema = (metatype as Partial<ZodDtoClass>).zodSchema;
  return schema;
}

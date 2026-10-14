import { ValidationError } from '@bf/contracts';
import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { zodSchemaOf } from './zod-dto.ts';

/** Global pipe: parameters typed with a `zodDto()` class are parsed (coerced, defaulted) or rejected with 422. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = zodSchemaOf(metadata.metatype);
    if (!schema) return value;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw ValidationError.fromZod(
      result.error,
      `Invalid ${metadata.type === 'custom' ? 'input' : metadata.type}.`,
    );
  }
}

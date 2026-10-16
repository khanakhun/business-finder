import { NotFoundError, type SecretName, SecretNameSchema } from '@bf/contracts';
import { Injectable, type PipeTransform } from '@nestjs/common';

/** `:name` must be a registry entry; anything else is a 404 (not a 422 listing the registry). */
@Injectable()
export class SecretNamePipe implements PipeTransform<string, SecretName> {
  transform(value: string): SecretName {
    const parsed = SecretNameSchema.safeParse(value);
    if (!parsed.success) throw new NotFoundError('Secret', value.slice(0, 64));
    return parsed.data;
  }
}

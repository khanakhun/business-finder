import { z } from 'zod';

/** A flat object schema whose keys are environment variable names. */
export type EnvSchema = z.ZodObject<Record<string, z.ZodType>>;

const secrets = new WeakSet<z.ZodType>();

/**
 * Marks a variable as secret: its value is never printed by reports, `env:check` or generated docs.
 * Apply it last — every Zod method returns a new schema instance, so `secret(x).describe(…)` loses the mark:
 *
 * ```ts
 * ANTHROPIC_API_KEY: secret(z.string().optional().describe('Anthropic API key.')),
 * ```
 */
export function secret<T extends z.ZodType>(schema: T): T {
  secrets.add(schema);
  return schema;
}

export function isSecret(schema: z.ZodType): boolean {
  return secrets.has(schema);
}

const BOOLEAN_STRINGS = ['true', 'false', '1', '0'] as const;

/** Strict boolean: only `true|false|1|0` are accepted (no "yes", no empty string). */
export function booleanFlag(defaultValue: boolean) {
  return z
    .enum(BOOLEAN_STRINGS)
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');
}

/** TCP port number from a string. */
export function port(defaultValue: number) {
  return z.coerce.number().int().min(1).max(65_535).default(defaultValue);
}

export interface VariableInfo {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  /** Default as it would appear in a `.env` file, if the schema has one. */
  readonly defaultValue: string | undefined;
  readonly secret: boolean;
}

/** Introspects an env schema for reports and generated documentation. */
export function describeVariables(schema: EnvSchema): VariableInfo[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const absent = field.safeParse(undefined);
    const fallback = absent.success ? absent.data : undefined;
    return {
      name,
      description: field.description ?? '',
      required: !absent.success,
      defaultValue: isPrimitive(fallback) ? String(fallback) : undefined,
      secret: isSecret(field),
    };
  });
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

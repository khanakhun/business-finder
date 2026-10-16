import {
  apply,
  type BaseOperation,
  BaseOperationSchema,
  type Operation,
  OperationError,
  OperationSchema,
  type SiteSpec,
} from '@bf/site-schema';
import { diffSpecs, type SpecDiff } from '@bf/site-schema/diff';

// Operations and diffs (BF-042): BF-033's operations applied atomically (a batch is all or nothing), with the inverse
// to undo and a one-line summary for the agent; the structural diff shared with the sites module.

export interface AppliedOps {
  readonly spec: SiteSpec;
  readonly inverse: Operation;
  readonly summary: string;
}

/** Parses operations from JSON (one, a list or a batch); throws `OperationError('invalid_path')` with the first problem. */
/** The operation names agents may use. */
export const OPERATION_NAMES: readonly string[] = BaseOperationSchema.options.map(
  (option) => (option.shape.op as { value: string }).value,
);

export function parseOperations(input: unknown): Operation {
  const candidate = Array.isArray(input) ? { op: 'batch', ops: input } : input;
  const steps: unknown[] =
    candidate && typeof candidate === 'object' && (candidate as { op?: unknown }).op === 'batch'
      ? ((candidate as { ops?: unknown[] }).ops ?? [])
      : [candidate];
  for (const [index, step] of steps.entries()) {
    const name = step && typeof step === 'object' ? (step as { op?: unknown }).op : undefined;
    if (typeof name !== 'string' || !OPERATION_NAMES.includes(name))
      throw new OperationError(
        'invalid_path',
        `Unknown operation ${JSON.stringify(name)} at ${index}. Operations: ${OPERATION_NAMES.join(', ')} (\`sitekit ops list\` shows their shapes).`,
      );
  }
  const parsed = OperationSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new OperationError(
      'invalid_path',
      `Invalid operation${first?.path.length ? ` at ${first.path.join('.')}` : ''}: ${first?.message ?? 'unknown'}. Run \`sitekit ops list\` for the shapes.`,
    );
  }
  return parsed.data;
}

export function summarize(operation: Operation): string {
  const steps: readonly BaseOperation[] = operation.op === 'batch' ? operation.ops : [operation];
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.op, (counts.get(step.op) ?? 0) + 1);
  const parts = [...counts].map(([op, count]) => (count > 1 ? `${op} ×${count}` : op));
  return `${steps.length} operation${steps.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

export function applyOps(spec: SiteSpec, operations: Operation | readonly BaseOperation[]): AppliedOps {
  const operation: Operation = Array.isArray(operations)
    ? { op: 'batch', ops: [...operations] }
    : (operations as Operation);
  const applied = apply(spec, operation);
  return { spec: applied.spec, inverse: applied.inverse, summary: summarize(operation) };
}

export function diff(a: SiteSpec, b: SiteSpec): SpecDiff {
  return diffSpecs(a, b);
}

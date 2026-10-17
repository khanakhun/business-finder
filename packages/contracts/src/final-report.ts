import { z } from 'zod';

// A coding agent's final report (BF-044): what it built and how it judges its work, the structured last message every
// sandboxed engine asks for (Claude Code `--json-schema`, Codex `--output-schema`, the Agent SDK `outputFormat`).
// The report is the agent's opinion, never trusted: the site is accepted on validation alone.

const text = (max: number) => z.string().trim().max(max);

export const EngineFinalReportSchema = z.object({
  summary: text(1500),
  pagesBuilt: z.array(text(80)).max(20),
  designDecisions: z.array(text(400)).max(12),
  openQuestions: z.array(text(400)).max(12),
  selfAssessment: z.object({
    score: z.number().int().min(1).max(5),
    reasons: z.array(text(400)).max(6),
  }),
});
export type EngineFinalReport = z.infer<typeof EngineFinalReportSchema>;

const LIMIT_KEYWORDS = new Set([
  'maxLength',
  'minLength',
  'maxItems',
  'minItems',
  'minimum',
  'maximum',
  'pattern',
]);

/**
 * Strict structured output: size keywords dropped (providers' strict modes reject several; the limits are ours to
 * check), every object closed with all its properties required.
 */
function strict(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strict);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !LIMIT_KEYWORDS.has(key))
      .map(([key, child]) => [key, strict(child)]),
  );
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The report's JSON Schema for the agents: every property required, no extra ones (strict structured output), the
 * score as an enum of 1–5 and no size limits (parsing with `EngineFinalReportSchema` enforces them).
 */
export function engineFinalReportJsonSchema(): Record<string, unknown> {
  const schema = strict(z.toJSONSchema(EngineFinalReportSchema, { target: 'draft-7', io: 'input' })) as {
    properties: { selfAssessment: { properties: { score: Record<string, unknown> } } };
  } & Record<string, unknown>;
  schema.properties.selfAssessment.properties.score = { type: 'integer', enum: [1, 2, 3, 4, 5] };
  delete schema.$schema;
  delete schema.id;
  return schema;
}

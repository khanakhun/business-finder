import { z } from 'zod';
import { defineTask } from '../define-task.ts';
import { untrusted } from '../untrusted.ts';

/** Grades a task's output against a rubric (eval harness only). */
export const EvalJudge = defineTask({
  name: 'eval.judge',
  kind: 'object',
  tier: 'smart',
  prompt: 'eval.judge.v1',
  input: z.object({ rubric: z.string(), input: z.string(), expected: z.string(), output: z.string() }),
  output: z.object({
    score: z.number().min(0).max(1).describe('0 = fails the rubric entirely, 1 = fully meets it.'),
    reason: z.string().describe('One or two sentences citing the rubric.'),
  }),
  temperature: 0,
  maxOutputTokens: 400,
  timeoutMs: 60_000,
  variables: (input) => ({
    rubric: input.rubric,
    input: untrusted('eval:input', input.input, { maxChars: 6_000 }),
    expected: untrusted('eval:expected', input.expected, { maxChars: 3_000 }),
    output: untrusted('eval:output', input.output, { maxChars: 3_000 }),
  }),
});

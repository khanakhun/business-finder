import type { SequenceSettings, SequenceStep } from '@bf/contracts';

// Safety rails of a sequence definition (BF-053): at least one email step, at most `maxEmails` (≤ 4), at least
// `minGapBusinessDays` (≥ 2) between two emails, variant weights that add up to 100, unique ids, and tasks that say
// what to do. Pure: the builder shows the same issues live.

export interface DefinitionIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export function validateDefinition(
  settings: SequenceSettings,
  steps: readonly SequenceStep[],
): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const emails = steps.filter((step) => step.kind === 'email');
  if (emails.length === 0)
    issues.push({ path: 'steps', code: 'no_email', message: 'A sequence needs at least one email step.' });
  if (emails.length > settings.maxEmails)
    issues.push({
      path: 'steps',
      code: 'too_many_emails',
      message: `At most ${settings.maxEmails} emails per sequence.`,
    });
  const ids = new Set<string>();
  let sinceEmail: number | null = null;
  steps.forEach((step, index) => {
    const path = `steps.${index}`;
    if (ids.has(step.id))
      issues.push({ path: `${path}.id`, code: 'duplicate_id', message: 'Step ids must be unique.' });
    ids.add(step.id);
    if (sinceEmail !== null) sinceEmail += step.wait.businessDays;
    if (step.kind === 'email') {
      // The first email may go at once (day 0); every later one waits the minimum gap after the previous email.
      if (sinceEmail !== null && sinceEmail < settings.minGapBusinessDays)
        issues.push({
          path: `${path}.wait`,
          code: 'gap_too_short',
          message: `Wait at least ${settings.minGapBusinessDays} business days between two emails.`,
        });
      sinceEmail = 0;
      if (step.variants.length === 0)
        issues.push({
          path: `${path}.variants`,
          code: 'no_variant',
          message: 'An email step needs a variant.',
        });
      const weights = step.variants.reduce((sum, variant) => sum + variant.weight, 0);
      if (step.variants.length > 0 && weights !== 100)
        issues.push({
          path: `${path}.variants`,
          code: 'weights',
          message: 'Variant weights must add up to 100.',
        });
      const variantIds = new Set(step.variants.map((variant) => variant.id));
      if (variantIds.size !== step.variants.length)
        issues.push({
          path: `${path}.variants`,
          code: 'duplicate_variant',
          message: 'Variant ids must be unique.',
        });
      for (const [v, variant] of step.variants.entries())
        if (!variant.templateId && !variant.instructions)
          issues.push({
            path: `${path}.variants.${v}`,
            code: 'empty_variant',
            message: 'A variant needs a template or AI instructions.',
          });
      if (index === 0 && step.threading === 'reply_in_thread' && step.condition !== 'always')
        issues.push({
          path: `${path}.condition`,
          code: 'first_condition',
          message: 'The first email cannot depend on preview views (nothing was sent yet).',
        });
    } else if (step.kind === 'task_custom' && !step.taskTitle)
      issues.push({ path: `${path}.taskTitle`, code: 'task_title', message: 'Say what the task is.' });
  });
  return issues;
}

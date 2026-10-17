import { linkViolations } from './link-policy.ts';
import { lintTemplate, maxWords, wordCount } from './template-lint.ts';

// The checks an AI draft must pass (BF-051, validator chain): cited ids exist, every number in the text appears in a
// cited item (no invented figures), only allowed links, no footer text or fake reply, length. Each failure is a
// sentence the model gets back for its one repair.

export interface DraftCheckInput {
  readonly subjects: readonly string[];
  readonly body: string;
  readonly purpose: string;
  readonly locale: 'en' | 'fr';
  /** id → its text (facts, findings with their metric values, themes, preview). */
  readonly ground: ReadonlyMap<string, string>;
  readonly cited: readonly string[];
  readonly previewUrl: string | null;
  readonly agencyUrl: string | null;
  /** Numbers that may appear without a citation (e.g. in the business name). */
  readonly freeText: readonly string[];
}

const NUMBERS = /\d+(?:[.,]\d+)?/g;

export function checkDraft(input: DraftCheckInput): string[] {
  const problems: string[] = [];
  for (const id of input.cited)
    if (!input.ground.has(id)) problems.push(`The id "${id}" does not exist: cite only the ids given.`);
  const citedText = input.cited.map((id) => input.ground.get(id) ?? '').join(' ');
  const allowed = `${citedText} ${input.freeText.join(' ')} ${input.previewUrl ?? ''}`;
  const text = `${input.subjects.join(' ')} ${input.body}`.replace(/https?:\/\/\S+/g, ' ');
  for (const number of new Set(text.match(NUMBERS) ?? []))
    if (!allowed.includes(number) && !allowed.includes(number.replace(',', '.')))
      problems.push(
        `The number "${number}" is not in any cited fact or finding: remove it or cite its source.`,
      );
  const links = linkViolations(input.body, { previewUrl: input.previewUrl, agencyUrl: input.agencyUrl });
  for (const url of links.disallowed)
    problems.push(`The link ${url} is not allowed: only the preview URL may appear.`);
  if (links.tooMany) problems.push('Too many links: at most two.');
  const lint = lintTemplate({
    subjects: input.subjects,
    body: input.body,
    purpose: input.purpose,
    locale: input.locale,
    template: false,
  });
  for (const issue of lint.issues)
    if (issue.severity === 'error' && issue.code !== 'unknown_variable' && issue.code !== 'syntax')
      problems.push(issue.message);
  if (wordCount(input.body) > maxWords(input.purpose))
    problems.push(`The body has ${wordCount(input.body)} words: at most ${maxWords(input.purpose)}.`);
  if (lint.issues.filter((issue) => issue.code === 'spam_phrase' || issue.code === 'shouting').length > 1)
    problems.push('Remove the spam-like phrases and capitals.');
  return [...new Set(problems)];
}

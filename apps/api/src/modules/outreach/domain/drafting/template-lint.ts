import { type LintIssue, TEMPLATE_VARIABLES } from '@bf/contracts';
import { linksIn } from './link-policy.ts';
import { spamWarnings } from './spam-lint.ts';
import { isKnownVariable, parseTemplate, TemplateSyntaxError, usedVariables } from './template-engine.ts';

// Template and draft lint (BF-051): syntax, variables (unknown ones; optional ones printed outside `{{#if}}`), the
// link policy (no literal URLs in templates: only `{{preview.url}}`), spam triggers, length, honest subjects (no
// "Re:"/"Fwd:" on a first touch, no clickbait), placeholder leftovers and compliance text that belongs in the footer.

const FOOTER_WORDS =
  /unsubscribe|se désinscrire|désabonner|opt[- ]out|politique de confidentialit|privacy policy/i;
const FAKE_REPLY = /^\s*(re|fwd?|tr)\s*:/i;
const CLICKBAIT = /(you won|vous avez gagné|last chance|dernière chance|\?\?|!!)/i;

export const wordCount = (text: string) =>
  text
    .replace(/\{\{[^}]*\}\}/g, ' x ')
    .split(/\s+/)
    .filter(Boolean).length;

export function maxWords(purpose: string) {
  return purpose === 'first_touch' ? 120 : 80;
}

export function lintTemplate(input: {
  readonly subjects: readonly string[];
  readonly body: string;
  readonly purpose: string;
  readonly locale: 'en' | 'fr';
  /** Templates: no literal URLs. Drafts check links against the policy instead. */
  readonly template: boolean;
}): { readonly issues: LintIssue[]; readonly variables: string[] } {
  const issues: LintIssue[] = [];
  const add = (code: string, severity: LintIssue['severity'], message: string, at: string | null = null) =>
    issues.push({ code, severity, message, at });
  let variables: string[] = [];
  for (const [index, source] of [input.body, ...input.subjects].entries()) {
    const at = index === 0 ? 'body' : `subject[${index - 1}]`;
    try {
      parseTemplate(source);
      variables.push(...usedVariables(source));
    } catch (error) {
      add('syntax', 'error', error instanceof TemplateSyntaxError ? error.message : 'Invalid template', at);
    }
  }
  variables = [...new Set(variables)].sort();
  for (const name of variables)
    if (name !== 'this' && !isKnownVariable(name))
      add('unknown_variable', 'error', `Unknown variable ${name}`, name);
  // An optional variable printed directly would fail to render when absent.
  const printed = [...input.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1] as string);
  const guarded = new Set(
    [...input.body.matchAll(/\{\{#(?:if|each)\s+([\w.]+)\s*\}\}/g)].map((m) => m[1] as string),
  );
  for (const name of new Set(printed))
    if (isKnownVariable(name) && !TEMPLATE_VARIABLES[name].required && !guarded.has(name))
      add('unguarded_optional', 'warning', `${name} is optional: wrap it in {{#if ${name}}}`, name);
  if (input.template && linksIn(input.body).length > 0)
    add('literal_link', 'error', 'Templates may not contain links; use {{preview.url}}', 'body');
  if (FOOTER_WORDS.test(input.body))
    add('footer_text', 'error', 'The unsubscribe and legal footer is added automatically', 'body');
  if (/\{\{|\}\}|\[\[|TODO|XXX|lorem ipsum/i.test(input.body.replace(/\{\{[^{}]*\}\}/g, '')))
    add('placeholder_left', 'error', 'A placeholder is left in the text', 'body');
  const words = wordCount(input.body);
  if (words > maxWords(input.purpose))
    add('too_long', 'warning', `${words} words; keep it under ${maxWords(input.purpose)}`, 'body');
  for (const [index, subject] of input.subjects.entries()) {
    if (input.purpose === 'first_touch' && FAKE_REPLY.test(subject))
      add('fake_reply', 'error', 'A first message cannot look like a reply or forward', `subject[${index}]`);
    if (CLICKBAIT.test(subject))
      add('clickbait', 'warning', 'The subject reads like clickbait', `subject[${index}]`);
    if (subject.length > 80)
      add('subject_long', 'warning', 'Keep the subject under 80 characters', `subject[${index}]`);
  }
  for (const warning of spamWarnings(`${input.subjects.join('\n')}\n${input.body}`, input.locale))
    add(warning.code, 'warning', `Spam trigger: ${warning.detail}`, null);
  return { issues, variables };
}

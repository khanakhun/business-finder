// The checks a call script or a WhatsApp message must pass (BF-057, shared rules with the email draft): cited ids
// exist, every number appears in a cited item (no invented figures), no links or addresses besides the preview. Each
// failure is a sentence the model gets back for its one repair.

const NUMBERS = /\d+(?:[.,]\d+)?/g;
const LINKS = /(https?:\/\/\S+|www\.\S+|\S+@\S+\.\w+)/gi;

export function checkGrounded(input: {
  readonly texts: readonly string[];
  readonly cited: readonly string[];
  /** id → its text. */
  readonly ground: ReadonlyMap<string, string>;
  /** Text whose numbers may appear without a citation (the business name, the preview URL). */
  readonly freeText: readonly string[];
}): string[] {
  const problems: string[] = [];
  for (const id of input.cited)
    if (!input.ground.has(id)) problems.push(`The id "${id}" does not exist: cite only the ids given.`);
  const allowed = [...input.cited.map((id) => input.ground.get(id) ?? ''), ...input.freeText].join(' ');
  const text = input.texts.join(' ');
  for (const link of new Set(text.match(LINKS) ?? []))
    problems.push(`Remove "${link}": no links, URLs or addresses (the preview link is added automatically).`);
  for (const number of new Set(text.replace(LINKS, ' ').match(NUMBERS) ?? []))
    if (!allowed.includes(number) && !allowed.includes(number.replace(',', '.')))
      problems.push(
        `The number "${number}" is not in any cited fact or finding: remove it or cite its source.`,
      );
  return [...new Set(problems)];
}

/** `https://wa.me/<digits>?text=…` (WhatsApp click-to-chat: the number without "+", the text URL-encoded). */
export function waUrl(e164: string, text: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

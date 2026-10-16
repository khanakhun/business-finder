// What an AI image may show (BF-038, ADR-0013): illustrative ambience only — textures, landscapes, generic objects,
// abstract interiors. Never people, text, logos or brand names, never something presented as the business's real
// premises, products or staff. Checked on the prompt here, in the prompt template, and on the result by vision.

const FORBIDDEN = [
  // People and faces, in English and French.
  /\b(people|person|persons|man|men|woman|women|child|children|kid|kids|girl|boy|face|faces|portrait|selfie|staff|team|employee|customer|client|chef|barber|stylist|model)s?\b/i,
  /\b(personne|personnes|homme|hommes|femme|femmes|enfant|enfants|visage|visages|portrait|équipe|employé|client|cliente|coiffeur|coiffeuse|serveur|serveuse)s?\b/i,
  // Text, logos and brands.
  /\b(text|texte|logo|logos|sign|signage|enseigne|brand|marque|trademark|lettering|typography|écriture|caption|watermark)\b/i,
  // Presenting the image as the real business.
  /\b(our|notre|nos)\s+(shop|store|salon|restaurant|boutique|magasin|premises|locaux|équipe|team)\b/i,
] as const;

export type PromptVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether a person's prompt asks only for what the policy allows. */
export function judgeImagePrompt(prompt: string): PromptVerdict {
  const text = prompt.normalize('NFKC');
  if (/https?:\/\//i.test(text)) return { ok: false, reason: 'links' };
  for (const pattern of FORBIDDEN)
    if (pattern.test(text)) return { ok: false, reason: 'people_text_or_brand' };
  return { ok: true };
}

/** A generated image the vision check found against the policy (people or text): discarded, never stored. */
export function violatesImagePolicy(analysis: {
  readonly containsPeople: boolean;
  readonly containsText: boolean;
}) {
  return analysis.containsPeople || analysis.containsText;
}

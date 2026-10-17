// Unsubscribe intent without the model (BF-054, compliance): phrases in English, French, Dutch and Spanish. When in
// doubt it says yes — suppressing someone who did not ask costs a lead, emailing someone who asked to stop is a breach.
// A negation ("please don't unsubscribe me") is reported but still counts: a person reviews the suppression.

const PHRASES: readonly RegExp[] = [
  // English
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bopt(ing)?[- ]?out\b/i,
  /\bstop (e-?mailing|emails?|sending|contacting|writing)\b/i,
  /\b(do not|don['’]t|never) (contact|e-?mail|write to) (me|us)\b/i,
  /\bno (more|further) (e-?mails?|messages|contact)\b/i,
  /\bnot interested,? (please )?stop\b/i,
  // French
  /\bdésinscri(re|vez|s|ption)\b/i,
  /\bdesinscri(re|vez|s|ption)\b/i,
  /\bne (plus|pas) (me )?(recevoir|contacter|écrire|ecrire|solliciter)\b/i,
  /\bne me (contactez|écrivez|ecrivez|sollicitez|relancez) (plus|pas)\b/i,
  /\b(retirez|supprimez|enlevez)[- ]moi\b/i,
  /\barr[êe]te[zr]? (de m['’](é|e)crire|de me contacter|de m['’]envoyer|les (e-?)?mails|vos (e-?)?mails)\b/i,
  /\bplus de (mails|e-mails|courriels|messages)\b/i,
  // Dutch
  /\bafmelden\b/i,
  /\buitschrijven\b/i,
  /\bgeen (e-?mails|berichten) meer\b/i,
  // Spanish
  /\bdar(me)? de baja\b/i,
  /\bcancelar (la )?suscripci[óo]n\b/i,
  /\bno (me )?(env[íi]en|escriban|contacten) m[áa]s\b/i,
];

const NEGATION =
  /\b(don['’]t|do not|ne pas|n['’]|niet|no)\b[^.!?\n]{0,20}(unsubscribe|désinscri|afmelden|baja)/i;

export interface UnsubscribeSignal {
  readonly detected: boolean;
  readonly phrase: string | null;
  readonly negated: boolean;
}

export function detectUnsubscribe(text: string, subject = ''): UnsubscribeSignal {
  const content = `${subject}\n${text}`;
  for (const phrase of PHRASES) {
    const match = content.match(phrase);
    if (match) return { detected: true, phrase: match[0], negated: NEGATION.test(content) };
  }
  // "STOP" alone (a line, the subject, or a very short reply).
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (/^\s*stop\s*[.!]*\s*$/im.test(content) || (words.length <= 4 && /\bstop\b/i.test(text)))
    return { detected: true, phrase: 'stop', negated: false };
  return { detected: false, phrase: null, negated: false };
}

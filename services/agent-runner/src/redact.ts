// Secret redaction (BF-043): every line the supervisor emits goes through it — the run's secret values (exact match)
// and anything shaped like a provider key (prefix patterns), whether or not it was declared.

const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
export const REDACTED = '[REDACTED]';
/** Secrets shorter than this are not matched literally (they would blank ordinary words). */
const MIN_SECRET = 8;

export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((secret) => secret.length >= MIN_SECRET))].sort(
    (a, b) => b.length - a.length,
  );
  return (text: string) => {
    let out = text;
    for (const value of values) out = out.split(value).join(REDACTED);
    for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  };
}

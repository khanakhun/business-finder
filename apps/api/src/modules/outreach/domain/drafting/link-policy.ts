// The link policy (BF-051, Specification): an email may link only to the preview made for the business and the
// agency's own website — at most two links, never a tracking redirect, never a raw IP.

const URL_PATTERN = /https?:\/\/[^\s<>()"'\]]+/gi;

/** Every http(s) URL in a markdown or plain text (markdown link targets included). */
export function linksIn(text: string): string[] {
  return [...new Set((text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:!?]+$/, '')))];
}

const origin = (url: string) => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
};

export interface LinkPolicyInput {
  readonly previewUrl: string | null;
  readonly agencyUrl: string | null;
}

/** The links not allowed by the policy (empty when compliant), and whether there are too many. */
export function linkViolations(
  text: string,
  policy: LinkPolicyInput,
): { readonly disallowed: string[]; readonly tooMany: boolean } {
  const allowed = new Set(
    [policy.previewUrl, policy.agencyUrl].filter(Boolean).map((url) => origin(url as string)),
  );
  const links = linksIn(text);
  const disallowed = links.filter((url) => {
    const host = origin(url);
    return !host || !allowed.has(host) || /^https?:\/\/\d{1,3}(\.\d{1,3}){3}/.test(url);
  });
  return { disallowed, tooMany: links.length > 2 };
}

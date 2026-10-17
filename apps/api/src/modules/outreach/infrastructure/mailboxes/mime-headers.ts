// Just enough RFC 5322 header reading for transports (BF-050): the envelope recipients of a raw message and its
// Message-ID. Full parsing of inbound mail is BF-054's.

/** Headers of a raw message, unfolded, by lower-case name. */
export function parseHeaders(raw: Buffer | string): Record<string, string[]> {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const end = text.search(/\r?\n\r?\n/);
  const block = end === -1 ? text : text.slice(0, end);
  const headers: Record<string, string[]> = {};
  let current: { name: string; value: string } | null = null;
  const flush = () => {
    if (!current) return;
    const list = headers[current.name] ?? [];
    list.push(current.value.trim());
    headers[current.name] = list;
    current = null;
  };
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon > 0)
      current = { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1) };
  }
  flush();
  return headers;
}

/** The addresses in address-list header values (`"Name" <a@b>, c@d`). */
export function addressesIn(values: readonly string[] | undefined): string[] {
  const found: string[] = [];
  for (const value of values ?? []) {
    for (const part of value.split(',')) {
      const angle = part.match(/<([^<>\s]+@[^<>\s]+)>/);
      const bare = part.trim().match(/^([^\s<>"]+@[^\s<>"]+)$/);
      const address = angle?.[1] ?? bare?.[1];
      if (address) found.push(address.toLowerCase());
    }
  }
  return [...new Set(found)];
}

export function messageIdOf(headers: Record<string, string[]>): string | null {
  return headers['message-id']?.[0]?.trim() ?? null;
}

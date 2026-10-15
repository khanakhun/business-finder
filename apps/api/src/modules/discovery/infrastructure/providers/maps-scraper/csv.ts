/** RFC 4180 CSV → rows of strings (quoted fields with commas, quotes and newlines). Bounded by `maxRows`. */
export function parseCsv(text: string, maxRows = 10_000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      if (rows.length > maxRows) break;
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows.slice(0, maxRows + 1);
}

/** Header row + data rows → objects keyed by header. */
export function csvObjects(text: string, maxRows = 10_000): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text, maxRows);
  if (!header) return [];
  return rows.map((values) => Object.fromEntries(header.map((key, i) => [key.trim(), values[i] ?? ''])));
}

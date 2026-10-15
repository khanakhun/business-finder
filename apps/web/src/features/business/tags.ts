/** Splits "a, b,c" into distinct tags (at most 20, the API's limit per request). */
export const parseTags = (text: string): string[] =>
  [
    ...new Set(
      text
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);

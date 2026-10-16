import { FONT_SUBSETS, type FontFamilyFiles } from './families.ts';

/** The @font-face rules of a package's stylesheet for our subsets, renamed to our family and our file paths. */
export function fontFaces(css: string, files: FontFamilyFiles): { rules: string[]; urls: string[] } {
  const rules: string[] = [];
  const urls: string[] = [];
  for (const [, comment, body] of css.matchAll(/\/\* ([\w-]+) \*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    // `inter-latin-ext-wght-normal`, `inter-latin-wght-normal`: the longest subset name that the comment names.
    const subset = [...FONT_SUBSETS]
      .sort((a, b) => b.length - a.length)
      .find((name) => comment?.startsWith(`${files.slug}-${name}-`));
    if (!subset || !body) continue;
    const url = /url\(\.\/files\/([\w.-]+\.woff2)\)/.exec(body)?.[1];
    if (!url) continue;
    const declarations = body
      .split(';')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('src:') && !line.startsWith('font-family:'));
    rules.push(
      `@font-face{font-family:"${files.family}";src:url(./fonts/${url}) format("woff2");${declarations.join(';')}}`,
    );
    urls.push(url);
  }
  return { rules, urls };
}

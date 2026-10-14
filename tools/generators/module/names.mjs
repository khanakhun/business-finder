// Name forms for a bounded context given in kebab-case (`lead-capture`).

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function names(context) {
  if (!KEBAB.test(context)) throw new Error(`Context "${context}" must be kebab-case, e.g. "lead-capture"`);
  if (['platform', 'system'].includes(context)) throw new Error(`"${context}" is reserved`);
  const words = context.split('-');
  const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return {
    kebab: context,
    pascal,
    camel: pascal[0].toLowerCase() + pascal.slice(1),
    constant: words.join('_').toUpperCase(),
    /** URL segment (plural-ish resources are the author's call; start with the context name). */
    route: context,
  };
}

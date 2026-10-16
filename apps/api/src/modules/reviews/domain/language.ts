// A review's language (BF-029): the source's own code when it gives one, else a stop-word count. French Creole
// counts as French (paraphrases of Creole reviews are written in French). `und` when nothing tells.

const FRENCH = new Set(
  (
    'le la les un une des du de et est était très pas mais avec pour nous on c ça trop bien je j il elle ils sont ' +
    'au aux ce cette qui que sur dans tout tous rien personne merci super accueil'
  ).split(' '),
);
const ENGLISH = new Set(
  (
    'the a an and is was were very not but with for we it its this that to of in on they you our great nice ' +
    'good bad no nobody thanks staff place would will'
  ).split(' '),
);
/** Antillean Creole markers (counted as French). */
const CREOLE = new Set('ka pa té ni moun mwen sé bèl manjé lanmè kay pou nou yo an'.split(' '));

export type ReviewLanguage = 'fr' | 'en' | 'und';

export function detectLanguage(text: string, sourceCode?: string): ReviewLanguage {
  const code = sourceCode?.toLowerCase().slice(0, 2);
  if (code === 'fr' || code === 'en') return code;
  let fr = 0;
  let en = 0;
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (FRENCH.has(word) || CREOLE.has(word)) fr += 1;
    if (ENGLISH.has(word)) en += 1;
  }
  if (fr === 0 && en === 0) return 'und';
  return fr >= en ? 'fr' : 'en';
}

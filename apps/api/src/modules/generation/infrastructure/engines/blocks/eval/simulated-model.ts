import type { AiGateway, SiteCopyInput, SiteCopyOutput, SitePlanInput, SitePlanOutput } from '@bf/ai';

// A SIMULATED model for the blocks engine's CI eval (BF-041): deterministic answers built from the input's facts,
// so the pipeline (plan checks, copy application, the self-check loop, the fallbacks) is measured on all the
// businesses without network or keys. It is not a quality measurement: judged metrics need real models
// (`pnpm --filter @bf/api eval:blocks`). Like a careless model, it follows an instruction it finds in the facts on
// the first ask (a superlative), and fixes it when asked again with the problem.

type Locale = 'fr' | 'en';
const lang = (locale: string): Locale => (locale === 'fr' ? 'fr' : 'en');
const NNBSP = ' ';

const HEADINGS: Record<string, Record<Locale, string>> = {
  highlights: { fr: 'L’essentiel', en: 'At a glance' },
  services: { fr: 'Nos prestations', en: 'What we offer' },
  menu: { fr: 'La carte', en: 'The menu' },
  about: { fr: 'Qui nous sommes', en: 'About us' },
  gallery: { fr: 'En images', en: 'In pictures' },
  testimonials: { fr: 'Ce qu’en disent nos clients', en: 'What our clients say' },
  hours: { fr: 'Horaires d’ouverture', en: 'Opening hours' },
  location: { fr: 'Nous trouver', en: 'Find us' },
  contact: { fr: 'Nous contacter', en: 'Get in touch' },
  faq: { fr: 'Questions fréquentes', en: 'Common questions' },
  team: { fr: 'L’équipe', en: 'The team' },
  booking: { fr: 'Réserver', en: 'Book a visit' },
  cta_banner: { fr: 'Appelez-nous pour réserver', en: 'Call us to book' },
};

const INTROS: Record<string, Record<Locale, string>> = {
  services: {
    fr: 'Voici ce que nous proposons. Appelez-nous pour en parler.',
    en: 'Here is what we offer. Call us to talk it through.',
  },
  menu: { fr: 'Découvrez la carte du moment.', en: 'See what is on the menu right now.' },
  contact: {
    fr: 'Écrivez-nous ou appelez-nous, nous répondons vite.',
    en: 'Write or call us and we will reply soon.',
  },
  booking: { fr: 'Réservez votre créneau en ligne.', en: 'Book your slot online.' },
  cta_banner: {
    fr: 'Un appel suffit pour fixer un rendez-vous.',
    en: 'One call is all it takes to set a time.',
  },
};

const PAGE_WORDS: Record<string, Record<Locale, string>> = {
  home: { fr: 'accueil', en: 'home' },
  services: { fr: 'prestations', en: 'services' },
  menu: { fr: 'la carte', en: 'menu' },
  about: { fr: 'qui nous sommes', en: 'about us' },
  contact: { fr: 'contact et accès', en: 'contact and directions' },
  gallery: { fr: 'en images', en: 'gallery' },
  booking: { fr: 'réservation', en: 'booking' },
};

const isInjection = (value: string) => /ignore (all |the )?previous|ignorez les instructions/i.test(value);

/** The fact of a kind in the locale (or without one), with its id. */
function factOf(input: SiteCopyInput, kind: string, locale: Locale) {
  const facts = input.facts.filter((fact) => fact.kind === kind && !isInjection(fact.value));
  return (
    facts.find((fact) => /[éèàçù]|\b(le|la|les|et|nos|des)\b/i.test(fact.value) === (locale === 'fr')) ??
    (facts.length === 1 && input.locales.length === 1 ? facts[0] : undefined)
  );
}

function copyText(
  input: SiteCopyInput,
  block: SiteCopyInput['blocks'][number],
  key: string,
  locale: Locale,
  reask: boolean,
): { text: string | undefined; facts: string[] } {
  const place = input.business.locality;
  const name = input.business.name;
  const injected = input.facts.some((fact) => isInjection(fact.value));
  if (block.type === 'hero') {
    if (key === 'eyebrow')
      return { text: place ? (locale === 'fr' ? `À ${place}` : `In ${place}`) : name, facts: [] };
    if (key === 'title') return { text: name, facts: [] };
    if (key === 'subtitle') {
      const tagline = factOf(input, 'tagline', locale);
      if (tagline) return { text: tagline.value, facts: [tagline.id] };
      return {
        text: place ? (locale === 'fr' ? `${name}, à ${place}.` : `${name}, in ${place}.`) : undefined,
        facts: [],
      };
    }
  }
  if (key === 'heading' || (block.type === 'cta_banner' && key === 'title'))
    return { text: HEADINGS[block.type]?.[locale], facts: [] };
  if (block.type === 'about' && key === 'body') {
    if (injected && !reask)
      return {
        text:
          locale === 'fr'
            ? `${name}, le meilleur de l’île, numéro un.`
            : `${name}, the best on the island, rated #1.`,
        facts: [],
      };
    const about = factOf(input, 'about_summary', locale);
    if (about && !reask) return { text: about.value, facts: [about.id] };
    return {
      text:
        locale === 'fr'
          ? `${name}${place ? `, à ${place}` : ''}. Passez nous voir ou appelez-nous.`
          : `${name}${place ? `, in ${place}` : ''}. Drop by or give us a call.`,
      facts: [],
    };
  }
  if (key === 'intro' || (block.type === 'cta_banner' && key === 'text'))
    return { text: INTROS[block.type]?.[locale], facts: [] };
  return { text: undefined, facts: [] };
}

function plan(input: SitePlanInput): SitePlanOutput {
  return {
    pages: input.pages.map((page) => ({
      id: page.id,
      blocks: page.blocks.map((block) => ({
        id: block.id,
        variant: block.variant,
        intent: `Present the ${block.type} of ${input.business.name}`.slice(0, 200),
      })),
    })),
    heroConcept: `${input.business.name}${input.business.locality ? ` in ${input.business.locality}` : ''}`,
    warnings: [],
  };
}

function copy(input: SiteCopyInput): SiteCopyOutput {
  const name = input.business.name;
  const place = input.business.locality;
  const services = input.facts.filter((fact) => fact.kind === 'service').map((fact) => fact.value);
  return {
    blocks: input.blocks.map((block) => {
      const reask = (block.problems?.length ?? 0) > 0;
      return {
        blockId: block.blockId,
        fields: block.fields.flatMap((field) => {
          const texts: Record<string, string> = {};
          const used = new Set<string>();
          for (const locale of input.locales) {
            const { text, facts } = copyText(input, block, field.key, lang(locale), reask);
            texts[locale] = (text ?? field.current[locale] ?? '').slice(0, field.maxChars);
            for (const id of facts) used.add(id);
          }
          return [{ key: field.key, texts, factsUsed: [...used] }];
        }),
      };
    }),
    seo: {
      title: Object.fromEntries(
        input.locales.map((locale) => [locale, `${name}${place ? ` · ${place}` : ''}`.slice(0, 60)]),
      ),
      description: Object.fromEntries(
        input.locales.map((locale) => {
          const offer = services.slice(0, 3).join(', ');
          const page = PAGE_WORDS[input.page.kind]?.[lang(locale)] ?? input.page.id;
          const text =
            lang(locale) === 'fr'
              ? `${name}${place ? ` à ${place}` : ''}, ${page}${NNBSP}: ${offer || 'nos coordonnées et l’accès'}. Appelez-nous ou écrivez-nous pour réserver ou poser une question.`
              : `${name}${place ? ` in ${place}` : ''}, ${page}: ${offer || 'our contact details and directions'}. Call or write to us to book or to ask a question.`;
          return [locale, text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, '')}.` : text];
        }),
      ),
    },
    warnings: input.facts.some((fact) => isInjection(fact.value))
      ? ['A fact contains an instruction; treated as data.']
      : [],
  };
}

/** The simulated gateway: plan and copy answers, a fixed cost per call. */
export function simulatedGateway(options: { costUsd?: number; latencyMs?: number } = {}): AiGateway {
  return {
    async run(task: { name: string }, input: unknown) {
      const output =
        task.name === 'generation.site_plan'
          ? plan(input as SitePlanInput)
          : task.name === 'generation.site_copy'
            ? copy(input as SiteCopyInput)
            : undefined;
      if (!output) throw new Error(`The simulated model does not answer ${task.name}`);
      return {
        output,
        provider: 'simulated',
        model: 'simulated',
        promptVersion: 1,
        usage: { inputTokens: 2_000, outputTokens: 800, cachedTokens: 0 },
        costUsd: options.costUsd ?? 0.01,
        cached: false,
        latencyMs: options.latencyMs ?? 0,
      };
    },
  } as unknown as AiGateway;
}

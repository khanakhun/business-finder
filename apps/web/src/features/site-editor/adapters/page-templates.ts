import {
  type Block,
  type BlockType,
  type LocalizedText,
  type Page,
  RESERVED_SLUGS,
  type SiteSpec,
} from '@bf/site-schema';
import { type DefaultsContext, defaultBlock } from '../puck/field-registry.ts';

// New pages from templates (BF-037): a hero and the sections a page of that kind needs, filled for the site the way
// new blocks are (texts in the default language, its images, never a fact). A template the site cannot fill is not
// offered.

export const PAGE_TEMPLATES = ['about', 'services', 'menu', 'contact', 'gallery', 'faq'] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

const SECTIONS: Readonly<Record<PageTemplate, readonly BlockType[]>> = {
  about: ['about'],
  services: ['services'],
  menu: ['menu'],
  contact: ['contact', 'location'],
  gallery: ['gallery'],
  faq: ['faq'],
};

/** The first free value of `base`, `base-2`, `base-3`… */
function free(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A new page of `template` for this site: a unique id and slug, its title and search texts in the default language,
 * a minimal hero and the template's sections; undefined when the site cannot fill one of them.
 */
export function pageFromTemplate(
  template: PageTemplate,
  spec: SiteSpec,
  options: DefaultsContext & { readonly title: string },
): Page | undefined {
  const id = free(template, new Set(spec.pages.map((page) => page.id)));
  const slug = free(template, new Set([...spec.pages.map((page) => page.slug), ...RESERVED_SLUGS]));
  const elementIds = new Set(spec.pages.flatMap((page) => page.blocks.map((block) => block.id)));
  const blocks: Block[] = [];
  for (const type of ['hero', ...SECTIONS[template]] as BlockType[]) {
    const fresh = defaultBlock(type, options);
    if (!fresh) return undefined;
    const blockId = free(`${type}-${id}`.slice(0, 28), elementIds);
    elementIds.add(blockId);
    // The page's hero: its title only (the minimal layout), the page's name as its text.
    const variant = type === 'hero' ? 'minimal' : fresh.variant;
    const props = fresh.props;
    blocks.push({
      id: blockId,
      type,
      variant,
      props: type === 'hero' ? { ...props, title: text(spec, options.title) } : props,
    } as Block);
  }
  return {
    id,
    slug,
    title: text(spec, options.title),
    seo: {
      title: text(spec, `${options.title} – ${spec.brand.name}`.slice(0, 70)),
      description: text(spec, `${options.title} – ${spec.brand.name}`),
    },
    blocks,
  };
}

const text = (spec: SiteSpec, value: string): LocalizedText => ({ [spec.defaultLocale]: value });

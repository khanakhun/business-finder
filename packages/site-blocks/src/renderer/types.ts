import type {
  Asset,
  BlockOf,
  BlockType,
  CtaAction,
  Fact,
  FactRegistry,
  LocalizedText,
  Page,
  SiteLocale,
  SiteSpec,
} from '@bf/site-schema';
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { UiStrings } from '../i18n/strings.ts';

/** What the image component receives (Next `Image` in apps/sites, a plain responsive `<img>` in static renders). */
export interface SiteImageProps {
  readonly src: string;
  readonly srcSet?: string | undefined;
  readonly sizes: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  /** Above the fold (the hero): loaded eagerly with a high fetch priority; every other image is lazy. */
  readonly priority?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
}
export type ImageComponent = ComponentType<SiteImageProps>;

/** What the link component receives (Next `Link` in apps/sites, a plain `<a>` elsewhere). */
export interface SiteLinkProps {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly 'aria-current'?: 'page' | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly hrefLang?: string | undefined;
  readonly lang?: string | undefined;
  readonly rel?: string | undefined;
}
export type LinkComponent = ComponentType<SiteLinkProps>;

/** An asset's URLs on our storage/CDN (the default keeps the spec's URL, no srcset). */
export type AssetsResolver = (asset: Asset) => { readonly src: string; readonly srcSet?: string | undefined };

export interface ResolvedImage {
  readonly src: string;
  readonly srcSet?: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
  /** The focal point as `object-position`. */
  readonly objectPosition?: string | undefined;
}

export interface ResolvedCta {
  readonly href: string;
  readonly label: string;
  readonly kind: CtaAction['kind'];
  /** Leaves the site (booking provider, WhatsApp, a map, the business's own domain). */
  readonly external: boolean;
}
export type CtaResolver = (action: CtaAction, ctx: RenderContext) => ResolvedCta | null;

export interface Logger {
  readonly error: (message: string, details?: Record<string, unknown>) => void;
}

export interface RenderOptions {
  readonly assetsResolver?: AssetsResolver;
  /** Replaces the default action resolution (e.g. to add tracking parameters on our own links). */
  readonly ctaResolver?: CtaResolver;
  readonly imageComponent?: ImageComponent;
  readonly linkComponent?: LinkComponent;
  /** A page's URL in a locale; the default serves the default locale at `/` and the others under `/<locale>/`. */
  readonly hrefForPage?: (page: Page, locale: SiteLocale, spec: SiteSpec) => string;
  /**
   * The fact registry: prices and testimonial quotes are then shown from their facts (the spec is untrusted), and a
   * quote shown in another language than its fact's is labelled as translated.
   */
  readonly facts?: FactRegistry;
  /** The agency named on the preview banner. */
  readonly agencyName?: string;
  /**
   * A preview of a site the business has not approved (BF-036 sets it for preview publications): the banner and
   * `noindex` whatever the spec says, and the contact form disabled (no visitor data before the business agrees).
   */
  readonly preview?: boolean;
  /** Where the contact form posts (BF-048); without it (or on a preview) the form is shown disabled. */
  readonly contactFormAction?: string;
  /** A static map image of the location on our storage (BF-036); without one a link to the map is shown. */
  readonly mapImage?: (geo: {
    lat: number;
    lng: number;
  }) => { src: string; width: number; height: number } | undefined;
  /** `development` throws on an unknown block type; `production` (the default) skips it and logs an error. */
  readonly mode?: 'development' | 'production';
  readonly logger?: Logger;
}

/** Everything a block needs to render: passed as a prop (Server Components have no context). */
export interface RenderContext {
  readonly spec: SiteSpec;
  readonly page: Page;
  readonly locale: SiteLocale;
  readonly strings: UiStrings;
  readonly options: RenderOptions;
  readonly Image: ImageComponent;
  readonly Link: LinkComponent;
  /** The text in the active locale (then the default locale, then any). */
  readonly t: (text: LocalizedText | undefined) => string;
  readonly image: (assetId: string | undefined) => ResolvedImage | undefined;
  readonly cta: (action: CtaAction | undefined) => ResolvedCta | null;
  readonly pageHref: (pageId: string, locale?: SiteLocale) => string | undefined;
  /** A fact of the registry, when one was given (prices and quotes are shown from their facts). */
  readonly fact: (factId: string) => Fact | undefined;
  /** The business's country (ISO 3166-1) and time zone, when known. */
  readonly country?: string | undefined;
  readonly timeZone?: string | undefined;
}

export interface BlockProps<T extends BlockType> {
  readonly block: BlockOf<T>;
  readonly ctx: RenderContext;
  /** `alt` sections sit on the surface colour (the family decides); the hero has none. */
  readonly tone?: 'base' | 'alt' | undefined;
  /** The block's position on the page (the first one is above the fold). */
  readonly index: number;
}
export type BlockComponent<T extends BlockType> = (props: BlockProps<T>) => ReactNode;

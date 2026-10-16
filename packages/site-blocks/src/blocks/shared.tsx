import { type CtaAction, type Inline, type LocalizedText, parseRichText } from '@bf/site-schema';
import type { ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';
import type { RenderContext } from '../renderer/types.ts';

// Building blocks shared by the blocks (BF-034): the section frame, its heading, buttons, images, text.

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

export { cx };

/** An item's heading level: under the section heading, or the section's own level when it has none (no skipped level). */
export const itemHeading = (sectionHeading: unknown): 'h2' | 'h3' => (sectionHeading ? 'h3' : 'h2');

/** The id of a block's heading (block ids are unique in a site, so this is unique on a page). */
/**
 * A block's DOM id: prefixed, so a block id never shadows a global (`__next_f`) or one of the layout's own ids
 * (`bf-mobile-menu`, `main`). Every id derived from a block starts from it.
 */
export const blockDomId = (blockId: string) => `b-${blockId}`;
/**
 * An id derived from a block's (its heading, a gallery photo, its form): `:` cannot appear in block ids, so a derived id
 * never equals another block's.
 */
export const derivedId = (blockId: string, part: string) => `${blockDomId(blockId)}:${part}`;
export const headingId = (blockId: string) => derivedId(blockId, 'title');

/** A block's section: its spacing, tone and accessible name. */
export function Section({
  id,
  type,
  variant,
  tone,
  labelled,
  className,
  children,
}: {
  id: string;
  type: string;
  variant: string;
  tone?: 'base' | 'alt' | undefined;
  /** The section has a visible heading (named by it). */
  labelled: boolean;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      id={blockDomId(id)}
      data-block={type}
      data-variant={variant}
      data-tone={tone}
      aria-labelledby={labelled ? headingId(id) : undefined}
      className={cx('bf-section', className)}
    >
      {children}
    </section>
  );
}

/** A section heading (h2) with its optional intro, aligned by the style family. */
export function SectionHead({
  blockId,
  heading,
  intro,
  eyebrow,
  fallback,
  align,
  ctx,
}: {
  blockId: string;
  /** `start` keeps the head left-aligned whatever the family (a head in a column beside other content). */
  align?: 'start' | undefined;
  heading: LocalizedText | undefined;
  /** A small label shown (as the section's heading) when the block has none. */
  fallback?: string | undefined;
  intro?: LocalizedText | undefined;
  eyebrow?: string | undefined;
  ctx: RenderContext;
}) {
  if (!heading) {
    return fallback ? (
      <header className="bf-section-head !mb-6" data-align={align}>
        <h2 id={headingId(blockId)} className="bf-eyebrow">
          {fallback}
        </h2>
      </header>
    ) : null;
  }
  return (
    <header className="bf-section-head" data-align={align}>
      {eyebrow ? <span className="bf-eyebrow">{eyebrow}</span> : null}
      <h2 id={headingId(blockId)} className="bf-h2">
        {ctx.t(heading)}
      </h2>
      {intro ? <p className="bf-lead">{ctx.t(intro)}</p> : null}
    </header>
  );
}

/** A button for an action; nothing when the action cannot be resolved (a channel the business does not publish). */
export function CtaButton({
  action,
  ctx,
  kind = 'primary',
  className,
}: {
  action: CtaAction | undefined;
  ctx: RenderContext;
  kind?: 'primary' | 'secondary';
  className?: string | undefined;
}) {
  const cta = ctx.cta(action);
  if (!cta) return null;
  const { Link } = ctx;
  return (
    <Link href={cta.href} className={cx('bf-btn', `bf-btn-${kind}`, className)}>
      {cta.label}
      {kind === 'secondary' && cta.kind === 'page' ? <Icon name="arrow_right" size={16} /> : null}
      {cta.external ? <Icon name="arrow_up_right" size={16} /> : null}
    </Link>
  );
}

/** The actions of a block, side by side; nothing when none resolves. */
export function Actions({
  primary,
  secondary,
  ctx,
  className,
}: {
  primary?: CtaAction | undefined;
  secondary?: CtaAction | undefined;
  ctx: RenderContext;
  className?: string | undefined;
}) {
  if (!ctx.cta(primary) && !ctx.cta(secondary)) return null;
  return (
    <div className={cx('bf-actions', className)}>
      <CtaButton action={primary} ctx={ctx} />
      <CtaButton action={secondary} ctx={ctx} kind="secondary" />
    </div>
  );
}

/** Aspect ratios images keep (no layout shift while they load). */
const RATIOS = {
  square: 'aspect-square',
  portrait: 'aspect-[4/5]',
  landscape: 'aspect-[3/2]',
  wide: 'aspect-[16/9]',
  natural: '',
} as const;

/** An asset in a frame of a fixed ratio (or its own), with the theme's radius and treatment. */
export function Media({
  assetId,
  ctx,
  ratio = 'landscape',
  sizes,
  priority = false,
  bleed = false,
  className,
}: {
  assetId: string | undefined;
  ctx: RenderContext;
  ratio?: keyof typeof RATIOS;
  sizes: string;
  priority?: boolean;
  /** Edge to edge (no frame, no radius). */
  bleed?: boolean;
  className?: string | undefined;
}) {
  const image = ctx.image(assetId);
  if (!image) return null;
  const { Image } = ctx;
  return (
    <div className={cx('bf-media', bleed && 'bf-bleed', RATIOS[ratio], className)}>
      <Image
        src={image.src}
        srcSet={image.srcSet}
        sizes={sizes}
        alt={image.alt}
        width={image.width}
        height={image.height}
        priority={priority}
        style={image.objectPosition ? { objectPosition: image.objectPosition } : undefined}
      />
    </div>
  );
}

/** Plain text in paragraphs (a blank line between paragraphs, a line break kept). */
export function Paragraphs({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <div className={cx('bf-prose', className)}>
      {paragraphs.map((paragraph, i) => {
        const lines = paragraph.split('\n');
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                {line}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function InlineNode({ node, ctx }: { node: Inline; ctx: RenderContext }): ReactNode {
  if (node.type === 'text') return node.text;
  const children = node.children.map((child, i) => <InlineNode key={i} node={child} ctx={ctx} />);
  if (node.type === 'strong') return <strong>{children}</strong>;
  if (node.type === 'em') return <em>{children}</em>;
  const href = ctx.pageHref(node.pageId);
  const { Link } = ctx;
  return href ? <Link href={href}>{children}</Link> : children;
}

function Inlines({ nodes, ctx }: { nodes: readonly Inline[]; ctx: RenderContext }): ReactNode {
  return nodes.map((node, i) => <InlineNode key={i} node={node} ctx={ctx} />);
}

/**
 * Rich text from `parseRichText` (BF-033), never a markdown library: paragraphs, lists, bold, italic and links to the
 * site's own pages. Anything outside the subset was already turned into plain text by the parser.
 */
export function RichTextBody({
  text,
  ctx,
  className,
}: {
  text: string;
  ctx: RenderContext;
  className?: string;
}) {
  const { blocks } = parseRichText(text);
  return (
    <div className={cx('bf-prose', className)}>
      {blocks.map((block, i) =>
        block.type === 'paragraph' ? (
          <p key={i}>
            <Inlines nodes={block.children} ctx={ctx} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines nodes={item} ctx={ctx} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/** A star rating, read as "4 out of 5 stars". */
export function Stars({ rating, ctx }: { rating: number; ctx: RenderContext }) {
  return (
    <span role="img" aria-label={ctx.strings.rating(rating)} className="inline-flex gap-0.5 text-accent">
      {[1, 2, 3, 4, 5].map((star) => (
        <svg key={star} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path
            d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"
            fill={star <= rating ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ))}
    </span>
  );
}

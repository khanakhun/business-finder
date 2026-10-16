import { Icon } from '../icons/icon.tsx';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { cx, derivedId, Media, Section, SectionHead } from './shared.tsx';

/** A photo that opens larger in a viewer (a native popover: no script, Esc and outside clicks close it). */
function Zoomable({
  assetId,
  viewerId,
  ctx,
  ratio,
  sizes,
}: {
  assetId: string;
  viewerId: string;
  ctx: RenderContext;
  ratio: 'square' | 'natural' | 'portrait';
  sizes: string;
}) {
  const image = ctx.image(assetId);
  if (!image) return null;
  const { Image } = ctx;
  return (
    <>
      <button
        type="button"
        className="bf-zoom"
        popoverTarget={viewerId}
        aria-label={ctx.strings.enlarge(image.alt)}
      >
        <Media assetId={assetId} ctx={ctx} ratio={ratio} sizes={sizes} />
      </button>
      <div
        id={viewerId}
        popover="auto"
        role="dialog"
        className="bf-popover bf-lightbox"
        aria-label={image.alt}
      >
        <figure className="flex max-h-full flex-col items-center gap-4">
          <Image
            src={image.src}
            srcSet={image.srcSet}
            sizes="100vw"
            alt={image.alt}
            width={image.width}
            height={image.height}
          />
          <figcaption aria-hidden="true" className="text-sm opacity-85">
            {image.alt}
          </figcaption>
        </figure>
        <button
          type="button"
          className="bf-icon-btn absolute right-4 top-4"
          popoverTarget={viewerId}
          popoverTargetAction="hide"
          aria-label={ctx.strings.close}
          // biome-ignore lint/a11y/noAutofocus: inside a popover, autofocus applies when it opens (never on page load)
          autoFocus
        >
          <Icon name="close" size={24} />
        </button>
      </div>
    </>
  );
}

/** Three to twelve photos. */
export function Gallery({ block, ctx, tone }: BlockProps<'gallery'>) {
  const { props, variant } = block;
  const ids = props.assetIds.filter((id) => ctx.image(id));
  const viewer = (i: number) => derivedId(block.id, `photo-${i}`);
  const label = props.heading ? undefined : ctx.strings.photos;
  return (
    <Section id={block.id} type="gallery" variant={variant} tone={tone} labelled={Boolean(props.heading)}>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        {variant === 'carousel' ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
          <ul className="bf-carousel" tabIndex={0} aria-label={label ?? ctx.t(props.heading)}>
            {ids.map((id, i) => (
              <li key={id}>
                <Zoomable
                  assetId={id}
                  viewerId={viewer(i)}
                  ctx={ctx}
                  ratio="portrait"
                  sizes="(min-width: 40rem) 26rem, 84vw"
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul
            aria-label={label}
            className={cx(
              variant === 'masonry'
                ? cx('bf-masonry', ids.length <= 4 && 'lg:!columns-2')
                : cx(
                    'grid grid-cols-2 gap-[calc(var(--bf-gap)*0.6)]',
                    ids.length % 3 === 0 && 'lg:grid-cols-3',
                  ),
            )}
          >
            {ids.map((id, i) => (
              <li key={id}>
                <Zoomable
                  assetId={id}
                  viewerId={viewer(i)}
                  ctx={ctx}
                  ratio={variant === 'masonry' ? 'natural' : 'square'}
                  sizes="(min-width: 64rem) 33vw, 50vw"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

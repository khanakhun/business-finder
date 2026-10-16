import { Icon } from '../icons/icon.tsx';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { shownQuote } from './facts.ts';
import { cx, Section, SectionHead, Stars } from './shared.tsx';

type Item = BlockProps<'testimonials'>['block']['props']['items'][number];

const SOURCES = { google: 'Google', tripadvisor: 'Tripadvisor', facebook: 'Facebook', direct: '' } as const;

function Quote({ item, ctx, large = false }: { item: Item; ctx: RenderContext; large?: boolean }) {
  const quote = shownQuote(item, ctx);
  const source = item.source ? SOURCES[item.source] : '';
  return (
    <figure className={cx('flex h-full flex-col gap-5', !large && 'bf-card')}>
      {item.rating ? (
        <Stars rating={item.rating} ctx={ctx} />
      ) : (
        <Icon name="quote" size={28} className="bf-icon" />
      )}
      <blockquote
        lang={quote.lang}
        className={cx(
          large ? 'bf-h2 !text-[clamp(1.4rem,1.1rem+1.4vw,2.2rem)] !leading-snug' : 'text-[1.05em]',
        )}
      >
        <p>{ctx.strings.quote(quote.text)}</p>
      </blockquote>
      <figcaption className="bf-muted mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {item.author ? <span className="font-semibold text-[var(--bf-text)]">{item.author}</span> : null}
        {source ? <span>{ctx.strings.reviewOn(source)}</span> : null}
        {quote.translated ? <span className="bf-badge !text-xs">{ctx.strings.translated}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Real customer quotes, from the fact registry only. */
export function Testimonials({ block, ctx, tone }: BlockProps<'testimonials'>) {
  const { props, variant } = block;
  const items = props.items;
  const label = props.heading ? undefined : ctx.strings.reviews;
  return (
    <Section
      id={block.id}
      type="testimonials"
      variant={variant}
      tone={tone}
      labelled={Boolean(props.heading)}
    >
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        {variant === 'quotes' ? (
          <ul className="mx-auto flex max-w-3xl flex-col gap-[calc(var(--bf-gap)*2)] text-center [&_figure]:items-center">
            {items.map((item) => (
              <li key={item.factId}>
                <Quote item={item} ctx={ctx} large />
              </li>
            ))}
          </ul>
        ) : variant === 'carousel' ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
          <ul className="bf-carousel" tabIndex={0} aria-label={label ?? ctx.t(props.heading)}>
            {items.map((item) => (
              <li key={item.factId}>
                <Quote item={item} ctx={ctx} />
              </li>
            ))}
          </ul>
        ) : (
          <ul
            className={cx('grid gap-[var(--bf-gap)] md:grid-cols-2', items.length >= 3 && 'lg:grid-cols-3')}
          >
            {items.map((item) => (
              <li key={item.factId}>
                <Quote item={item} ctx={ctx} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

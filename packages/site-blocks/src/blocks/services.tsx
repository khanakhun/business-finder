import type { BlockProps } from '../renderer/types.ts';
import { shownPrice } from './facts.ts';
import { CtaButton, cx, Media, Section, SectionHead } from './shared.tsx';

/** What the business offers; prices only from price facts. */
export function Services({ block, ctx, tone }: BlockProps<'services'>) {
  const { props, variant } = block;
  const section = { id: block.id, type: 'services', variant, tone, labelled: true };
  const head = <SectionHead blockId={block.id} heading={props.heading} intro={props.intro} ctx={ctx} />;

  if (variant === 'list') {
    return (
      <Section {...section}>
        <div className="bf-container">
          {head}
          <ul className="bf-divided mx-auto max-w-3xl">
            {props.items.map((item, i) => (
              <li key={i} className="flex flex-col gap-1.5 py-5">
                <div className="flex items-baseline">
                  <h3 className="bf-h3">{ctx.t(item.title)}</h3>
                  {item.price && shownPrice(item.price, ctx) ? (
                    <>
                      <span className="bf-leader" aria-hidden="true" />
                      <span className="bf-num whitespace-nowrap font-medium">
                        {shownPrice(item.price, ctx)}
                      </span>
                    </>
                  ) : null}
                </div>
                {item.description ? <p className="bf-muted bf-measure">{ctx.t(item.description)}</p> : null}
                {item.cta ? (
                  <CtaButton action={item.cta} ctx={ctx} kind="secondary" className="self-start" />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </Section>
    );
  }

  const cards = variant === 'cards';
  return (
    <Section {...section}>
      <div className="bf-container">
        {head}
        <ul
          className={cx(
            'grid gap-[var(--bf-gap)] sm:grid-cols-2',
            props.items.length % 3 === 0 || props.items.length > 4 ? 'lg:grid-cols-3' : 'lg:grid-cols-2',
          )}
        >
          {props.items.map((item, i) => (
            <li key={i} className={cx('flex flex-col', cards ? 'bf-card !p-0 overflow-hidden' : 'bf-card')}>
              {cards ? (
                <Media
                  assetId={item.imageAssetId}
                  ctx={ctx}
                  ratio="landscape"
                  bleed
                  sizes="(min-width: 64rem) 33vw, (min-width: 40rem) 50vw, 100vw"
                />
              ) : null}
              <div className={cx('flex flex-1 flex-col gap-3', cards && 'p-[clamp(1.5rem,2.5vw,2.25rem)]')}>
                {!cards ? (
                  <Media
                    assetId={item.imageAssetId}
                    ctx={ctx}
                    ratio="landscape"
                    className="mb-2"
                    sizes="(min-width: 64rem) 33vw, (min-width: 40rem) 50vw, 100vw"
                  />
                ) : null}
                <h3 className="bf-h3">{ctx.t(item.title)}</h3>
                {item.description ? <p className="bf-muted">{ctx.t(item.description)}</p> : null}
                {item.price || item.cta ? (
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-3">
                    {item.price ? (
                      <span className="bf-num text-lg font-medium">{shownPrice(item.price, ctx)}</span>
                    ) : (
                      <span />
                    )}
                    <CtaButton action={item.cta} ctx={ctx} kind="secondary" />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

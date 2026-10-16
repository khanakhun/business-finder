import type { BlockProps } from '../renderer/types.ts';
import { shownPrice } from './facts.ts';
import { cx, Section, SectionHead } from './shared.tsx';

type MenuSection = BlockProps<'menu'>['block']['props']['sections'][number];

function Dishes({ section, ctx }: { section: MenuSection; ctx: BlockProps<'menu'>['ctx'] }) {
  return (
    <ul className="flex flex-col gap-5">
      {section.items.map((item, i) => (
        <li key={i} className="flex flex-col gap-1">
          <div className="flex items-baseline">
            <span className="font-medium">{ctx.t(item.name)}</span>
            {item.price ? (
              <>
                <span className="bf-leader" aria-hidden="true" />
                <span className="bf-num whitespace-nowrap">{shownPrice(item.price, ctx)}</span>
              </>
            ) : null}
          </div>
          {item.description ? <p className="bf-muted text-[0.95em]">{ctx.t(item.description)}</p> : null}
          {item.tags && item.tags.length > 0 ? (
            <ul className="flex flex-wrap gap-2 pt-1" aria-label={ctx.t(item.name)}>
              {item.tags.map((tag) => (
                <li key={tag} className="bf-badge bf-muted !text-xs">
                  {ctx.strings.menuTags[tag]}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A food or drinks menu from the published menu. */
export function Menu({ block, ctx, tone }: BlockProps<'menu'>) {
  const { props, variant } = block;
  const sections = props.sections;
  return (
    <Section id={block.id} type="menu" variant={variant} tone={tone} labelled>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} intro={props.intro} ctx={ctx} />
        <div
          className={cx(
            'grid gap-x-[calc(var(--bf-gap)*2.5)] gap-y-[calc(var(--bf-gap)*1.75)]',
            variant === 'columns' && sections.length > 1 && 'lg:grid-cols-2',
            variant === 'list' && 'mx-auto max-w-2xl',
            variant === 'cards' && 'gap-[var(--bf-gap)] md:grid-cols-2',
          )}
        >
          {sections.map((section, i) => (
            <section
              key={i}
              className={cx('flex flex-col gap-6', variant === 'cards' && 'bf-card')}
              aria-label={ctx.t(section.title)}
            >
              <h3 className="bf-h3 border-b border-[var(--bf-line)] pb-3">{ctx.t(section.title)}</h3>
              <Dishes section={section} ctx={ctx} />
            </section>
          ))}
        </div>
        {props.note ? (
          <p className="bf-muted mt-[calc(var(--bf-gap)*1.5)] text-center text-sm">{ctx.t(props.note)}</p>
        ) : null}
      </div>
    </Section>
  );
}

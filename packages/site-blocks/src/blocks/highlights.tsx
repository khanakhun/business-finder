import { Icon } from '../icons/icon.tsx';
import type { BlockProps } from '../renderer/types.ts';
import { cx, itemHeading, Section, SectionHead } from './shared.tsx';

/** Two to six strengths at a glance. */
export function Highlights({ block, ctx, tone }: BlockProps<'highlights'>) {
  const { props, variant } = block;
  const items = props.items;
  const columns =
    items.length === 4 ? 'lg:grid-cols-4' : items.length % 3 === 0 ? 'lg:grid-cols-3' : 'lg:grid-cols-2';
  const head = <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />;
  const Item = itemHeading(props.heading);
  const section = { id: block.id, type: 'highlights', variant, tone, labelled: Boolean(props.heading) };

  if (variant === 'inline') {
    return (
      <Section {...section} className="!py-[calc(var(--bf-section-space)*0.6)]">
        <div className="bf-container">
          {head}
          <ul className="flex flex-wrap justify-center gap-x-10 gap-y-5">
            {items.map((item, i) => (
              <li key={i} className="flex items-center gap-3">
                <Icon name={item.icon} className="bf-icon" />
                <span className="font-medium">{ctx.t(item.title)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    );
  }

  return (
    <Section {...section}>
      <div className="bf-container">
        {head}
        <ul className={cx('grid gap-[var(--bf-gap)] sm:grid-cols-2', columns)}>
          {items.map((item, i) => (
            <li key={i} className={cx('flex flex-col gap-4', variant === 'cards' && 'bf-card')}>
              <span className={variant === 'cards' ? 'bf-icon-badge' : 'text-accent'}>
                <Icon name={item.icon} size={variant === 'cards' ? 22 : 28} />
              </span>
              <Item className="bf-h3">{ctx.t(item.title)}</Item>
              {item.text ? <p className="bf-muted">{ctx.t(item.text)}</p> : null}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

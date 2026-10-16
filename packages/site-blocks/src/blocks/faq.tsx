import { Icon } from '../icons/icon.tsx';
import type { BlockProps } from '../renderer/types.ts';
import { Paragraphs, Section, SectionHead } from './shared.tsx';

/** Common questions: native `<details>` (keyboard and screen readers work without script). */
export function Faq({ block, ctx, tone }: BlockProps<'faq'>) {
  const { props, variant } = block;
  return (
    <Section id={block.id} type="faq" variant={variant} tone={tone} labelled={Boolean(props.heading)}>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        {variant === 'accordion' ? (
          <div className="bf-divided mx-auto max-w-3xl border-y border-[var(--bf-hairline)]">
            {props.items.map((item, i) => (
              <details key={i} className="bf-details">
                <summary>
                  <span className="text-[1.05rem] font-semibold">{ctx.t(item.question)}</span>
                  <Icon name="plus" className="bf-chevron bf-icon" />
                </summary>
                <Paragraphs text={ctx.t(item.answer)} className="bf-muted pb-6" />
              </details>
            ))}
          </div>
        ) : (
          <dl className="grid gap-x-[calc(var(--bf-gap)*2)] gap-y-[calc(var(--bf-gap)*1.25)] md:grid-cols-2">
            {props.items.map((item, i) => (
              <div key={i} className="flex flex-col gap-2">
                <dt className="bf-h3 !text-[1.15rem]">{ctx.t(item.question)}</dt>
                <dd>
                  <Paragraphs text={ctx.t(item.answer)} className="bf-muted" />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Section>
  );
}

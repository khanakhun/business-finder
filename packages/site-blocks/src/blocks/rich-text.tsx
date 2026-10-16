import type { BlockProps } from '../renderer/types.ts';
import { cx, RichTextBody, Section, SectionHead } from './shared.tsx';

/** Free text (legal notices, longer content) in the rich-text subset. */
export function RichText({ block, ctx, tone }: BlockProps<'rich_text'>) {
  const { props, variant } = block;
  return (
    <Section id={block.id} type="rich_text" variant={variant} tone={tone} labelled={Boolean(props.heading)}>
      <div
        className={cx(
          'bf-container',
          variant === 'narrow' ? 'max-w-[calc(var(--bf-measure)+6rem)]' : 'max-w-5xl',
        )}
      >
        <div className="[&_.bf-section-head]:!items-start [&_.bf-section-head]:!text-left [&_.bf-section-head]:!mx-0">
          <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        </div>
        <RichTextBody
          text={ctx.t(props.body)}
          ctx={ctx}
          className={cx(variant === 'wide' && '!max-w-none md:columns-2 md:gap-12 [&>*]:break-inside-avoid')}
        />
      </div>
    </Section>
  );
}

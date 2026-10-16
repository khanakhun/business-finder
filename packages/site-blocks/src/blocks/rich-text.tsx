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
        <SectionHead blockId={block.id} heading={props.heading} align="start" ctx={ctx} />
        <RichTextBody
          text={ctx.t(props.body)}
          ctx={ctx}
          className={cx(variant === 'wide' && '!max-w-none md:columns-2 md:gap-12 [&>*]:break-inside-avoid')}
        />
      </div>
    </Section>
  );
}

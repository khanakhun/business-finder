import type { BlockProps } from '../renderer/types.ts';
import { CtaButton, cx, headingId, Media, Section } from './shared.tsx';

/** A band that asks for one action. */
export function CtaBanner({ block, ctx, tone }: BlockProps<'cta_banner'>) {
  const { props, variant } = block;
  const image = variant === 'image' ? ctx.image(props.imageAssetId) : undefined;
  const content = (
    <div className="relative z-10 flex flex-col items-center gap-5 text-center">
      <h2 id={headingId(block.id)} className="bf-h2 max-w-3xl">
        {ctx.t(props.title)}
      </h2>
      {props.text ? <p className="bf-lead">{ctx.t(props.text)}</p> : null}
      <CtaButton action={props.cta} ctx={ctx} className="mt-2" />
    </div>
  );

  if (variant === 'outline') {
    return (
      <Section id={block.id} type="cta_banner" variant={variant} tone={tone} labelled>
        <div className="bf-container">
          <div className="rounded-card border border-[var(--bf-line)] px-6 py-[calc(var(--bf-section-space)*0.7)]">
            {content}
          </div>
        </div>
      </Section>
    );
  }

  return (
    <Section
      id={block.id}
      type="cta_banner"
      variant={variant}
      labelled
      className={cx(image ? 'bf-on-image bf-overlay bf-overlay-strong overflow-hidden' : 'bf-on-primary')}
    >
      {image ? (
        <Media
          assetId={props.imageAssetId}
          ctx={ctx}
          ratio="natural"
          bleed
          sizes="100vw"
          className="!absolute inset-0"
        />
      ) : null}
      <div className="bf-container relative z-10">{content}</div>
    </Section>
  );
}

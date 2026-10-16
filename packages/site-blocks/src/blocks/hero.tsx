import type { BlockProps } from '../renderer/types.ts';
import { Actions, cx, headingId, Media, Section } from './shared.tsx';

/** The first section: headline, a sentence, the main action; the only h1 of the page. */
export function Hero({ block, ctx, index }: BlockProps<'hero'>) {
  const { props, variant } = block;
  const priority = index === 0;
  const eyebrow = props.eyebrow ? <span className="bf-eyebrow">{ctx.t(props.eyebrow)}</span> : null;
  const title = (
    <h1 id={headingId(block.id)} className="bf-display">
      {ctx.t(props.title)}
    </h1>
  );
  const subtitle = props.subtitle ? <p className="bf-lead">{ctx.t(props.subtitle)}</p> : null;
  const actions =
    ctx.cta(props.primaryCta) || ctx.cta(props.secondaryCta) ? (
      <Actions primary={props.primaryCta} secondary={props.secondaryCta} ctx={ctx} />
    ) : null;
  const image = ctx.image(props.imageAssetId);
  const frame = (className: string) => ({ id: block.id, type: 'hero', variant, labelled: true, className });

  switch (variant) {
    case 'split':
      return (
        <Section {...frame('!pt-[calc(var(--bf-section-space)*0.6)]')}>
          <div className="bf-container grid items-center gap-[calc(var(--bf-gap)*2)] lg:grid-cols-[1.05fr_1fr]">
            <div className="flex flex-col gap-6">
              {eyebrow}
              {title}
              {subtitle}
              {actions ? <div className="pt-2">{actions}</div> : null}
            </div>
            <Media
              assetId={props.imageAssetId}
              ctx={ctx}
              ratio="portrait"
              priority={priority}
              sizes="(min-width: 64rem) 50vw, 100vw"
              className="max-lg:aspect-[4/3]"
            />
          </div>
        </Section>
      );
    case 'image_full':
      return (
        <Section {...frame('!p-0')}>
          <div
            className={cx(
              'relative flex min-h-[min(88svh,52rem)] items-end bf-on-image',
              image ? 'bf-overlay' : 'bg-primary text-on-primary',
            )}
          >
            {image ? (
              <Media
                assetId={props.imageAssetId}
                ctx={ctx}
                ratio="natural"
                bleed
                priority={priority}
                sizes="100vw"
                className="!absolute inset-0 !rounded-none"
              />
            ) : null}
            <div className="bf-container relative z-10 pb-[calc(var(--bf-section-space)*0.9)] pt-40">
              <div className="flex max-w-3xl flex-col gap-6">
                {eyebrow}
                {title}
                {subtitle}
                {actions ? <div className="pt-2">{actions}</div> : null}
              </div>
            </div>
          </div>
        </Section>
      );
    case 'centered':
      return (
        <Section {...frame('text-center')}>
          <div className="bf-container flex flex-col items-center gap-6">
            {eyebrow}
            <div className="max-w-4xl">{title}</div>
            {subtitle ? <div className="flex justify-center">{subtitle}</div> : null}
            {actions ? <div className="flex justify-center pt-2">{actions}</div> : null}
            {image ? (
              <Media
                assetId={props.imageAssetId}
                ctx={ctx}
                ratio="wide"
                priority={priority}
                sizes="(min-width: 76rem) 76rem, 100vw"
                className="mt-[calc(var(--bf-gap)*1.5)] w-full"
              />
            ) : null}
          </div>
        </Section>
      );
    case 'minimal':
      return (
        <Section
          {...frame('!pb-[calc(var(--bf-section-space)*0.55)] !pt-[calc(var(--bf-section-space)*0.75)]')}
        >
          <div className="bf-container flex flex-col gap-5">
            {eyebrow}
            <div className="max-w-4xl">{title}</div>
            {subtitle}
            {actions ? <div className="pt-1">{actions}</div> : null}
          </div>
        </Section>
      );
  }
}

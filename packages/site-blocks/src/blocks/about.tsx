import type { BlockProps } from '../renderer/types.ts';
import { cx, headingId, Media, Paragraphs, Section } from './shared.tsx';

/** Who the business is: neutral and factual. */
export function About({ block, ctx, tone }: BlockProps<'about'>) {
  const { props, variant } = block;
  const body = ctx.t(props.body);
  const heading = (
    <h2 id={headingId(block.id)} className="bf-h2">
      {ctx.t(props.heading)}
    </h2>
  );
  const hasImage = Boolean(ctx.image(props.imageAssetId));

  if (variant === 'split') {
    return (
      <Section id={block.id} type="about" variant={variant} tone={tone} labelled>
        <div
          className={cx(
            'bf-container grid items-center gap-[calc(var(--bf-gap)*2)]',
            hasImage && 'lg:grid-cols-2',
          )}
        >
          <Media
            assetId={props.imageAssetId}
            ctx={ctx}
            ratio="portrait"
            sizes="(min-width: 64rem) 50vw, 100vw"
            className="max-lg:aspect-[3/2]"
          />
          <div className="flex flex-col gap-6">
            {heading}
            <Paragraphs text={body} />
          </div>
        </div>
      </Section>
    );
  }

  if (variant === 'story') {
    const [first, ...rest] = body.split(/\n\s*\n/);
    return (
      <Section id={block.id} type="about" variant={variant} tone={tone} labelled>
        <div className="bf-container flex flex-col gap-[calc(var(--bf-gap)*1.5)]">
          <div className="grid gap-[calc(var(--bf-gap)*1.5)] lg:grid-cols-[1fr_1.4fr]">
            {heading}
            <p className="bf-lead !max-w-none !text-[clamp(1.25rem,1.05rem+0.8vw,1.6rem)] !text-[var(--bf-text)]">
              {first}
            </p>
          </div>
          <Media
            assetId={props.imageAssetId}
            ctx={ctx}
            ratio="wide"
            sizes="(min-width: 76rem) 76rem, 100vw"
          />
          {rest.length > 0 ? (
            <Paragraphs text={rest.join('\n\n')} className="lg:ml-[calc(41.6%+var(--bf-gap)*0.6)]" />
          ) : null}
        </div>
      </Section>
    );
  }

  return (
    <Section id={block.id} type="about" variant={variant} tone={tone} labelled>
      <div className="bf-container flex flex-col items-center gap-6 text-center">
        {heading}
        <Paragraphs text={body} className="mx-auto" />
        {hasImage ? (
          <Media
            assetId={props.imageAssetId}
            ctx={ctx}
            ratio="wide"
            sizes="(min-width: 76rem) 76rem, 100vw"
            className="mt-4 w-full"
          />
        ) : null}
      </div>
    </Section>
  );
}

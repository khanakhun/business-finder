import { BookingEmbed } from '../islands/booking-embed.tsx';
import { hostOfUrl, isEmbeddable } from '../renderer/embeds.ts';
import type { BlockProps } from '../renderer/types.ts';
import { cx, headingId, Section } from './shared.tsx';

/** Sends visitors to the business's existing booking page; `embed` shows it in place, on request only. */
export function Booking({ block, ctx, tone }: BlockProps<'booking'>) {
  const { props, variant } = block;
  const url = ctx.spec.contact.bookingUrl?.value;
  const { Link } = ctx;
  const embed = variant === 'embed' && url && isEmbeddable(url);
  return (
    <Section id={block.id} type="booking" variant={variant} tone={tone} labelled>
      <div className={cx('bf-container flex flex-col items-center gap-6 text-center')}>
        <h2 id={headingId(block.id)} className="bf-h2">
          {ctx.t(props.heading)}
        </h2>
        {props.intro ? <p className="bf-lead">{ctx.t(props.intro)}</p> : null}
        {url ? (
          embed ? (
            <BookingEmbed
              src={url}
              label={ctx.t(props.label)}
              notice={ctx.strings.booking.notice(hostOfUrl(url))}
              show={ctx.strings.booking.show}
              frameTitle={ctx.strings.booking.frameTitle}
            />
          ) : (
            <Link href={url} className="bf-btn bf-btn-primary">
              {ctx.t(props.label)}
            </Link>
          )
        ) : null}
      </div>
    </Section>
  );
}

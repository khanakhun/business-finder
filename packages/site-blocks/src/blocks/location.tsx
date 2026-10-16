import { Icon } from '../icons/icon.tsx';
import { mapLink } from '../renderer/resolvers.ts';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { cx, Section, SectionHead } from './shared.tsx';

/** The address as lines (`<address>`). */
export function AddressLines({ ctx }: { ctx: RenderContext }) {
  const address = ctx.spec.contact.address;
  if (!address) return null;
  const lines = [
    address.street,
    [address.postalCode, address.locality].filter(Boolean).join(' '),
    address.region,
  ].filter((line): line is string => Boolean(line));
  return (
    <address className="not-italic leading-relaxed">
      {(lines.length > 0 ? lines : [address.formatted]).map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </address>
  );
}

/**
 * The map: a static image of the place on our storage when the renderer provides one, else a quiet drawn panel with
 * a link to OpenStreetMap — never a third-party map loaded by the page (no tracking, no cookie banner).
 */
function MapPanel({ ctx, tall }: { ctx: RenderContext; tall: boolean }) {
  const { geo, address } = ctx.spec.contact;
  const href = mapLink(ctx.spec.contact);
  const place = address?.formatted ?? ctx.spec.brand.name;
  const image = geo ? ctx.options.mapImage?.(geo) : undefined;
  const { Image, Link } = ctx;
  return (
    <div
      className={cx(
        'bf-media relative w-full',
        tall ? 'aspect-[4/3] lg:aspect-auto lg:min-h-[26rem]' : 'aspect-[21/9] max-sm:aspect-[4/3]',
      )}
    >
      {image ? (
        <Image
          src={image.src}
          sizes="(min-width: 64rem) 50vw, 100vw"
          alt={ctx.strings.mapOf(place)}
          width={image.width}
          height={image.height}
        />
      ) : (
        <svg
          aria-hidden="true"
          focusable="false"
          className="absolute inset-0 h-full w-full text-[var(--bf-muted)] opacity-25"
          preserveAspectRatio="xMidYMid slice"
          viewBox="0 0 400 300"
        >
          <path
            d="M-10 210 C 80 180, 140 240, 220 200 S 340 120, 420 150"
            fill="none"
            stroke="currentColor"
            strokeWidth="14"
          />
          <path
            d="M60 -10 L 120 320 M 250 -10 L 210 320 M -10 90 L 420 60"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            d="M-10 140 L 420 250 M 330 -10 L 380 320"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      )}
      <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-primary drop-shadow">
        <Icon name="map_pin" size={40} />
      </span>
      {href ? (
        <Link href={href} className="bf-btn bf-btn-primary absolute bottom-4 right-4">
          {ctx.strings.openMap}
          <Icon name="arrow_up_right" size={16} />
        </Link>
      ) : null}
    </div>
  );
}

/** Where the business is, from `contact.address` and `contact.geo`. */
export function Location({ block, ctx, tone }: BlockProps<'location'>) {
  const { props, variant } = block;
  const { contact } = ctx.spec;
  if (!contact.address && !contact.geo) return null;
  const directions = props.showDirections
    ? ctx.cta({ kind: 'directions', label: { [ctx.locale]: ctx.strings.directions } })
    : null;
  const { Link } = ctx;
  const details = (
    <div className="flex flex-col gap-5">
      <div className="flex gap-3">
        <Icon name="map_pin" className="bf-icon mt-1" />
        <AddressLines ctx={ctx} />
      </div>
      {props.note ? <p className="bf-muted">{ctx.t(props.note)}</p> : null}
      {directions ? (
        <Link href={directions.href} className="bf-btn bf-btn-secondary self-start">
          <Icon name="navigation" size={16} />
          {directions.label}
        </Link>
      ) : null}
    </div>
  );
  return (
    <Section id={block.id} type="location" variant={variant} tone={tone} labelled>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} fallback={ctx.strings.address} ctx={ctx} />
        {variant === 'address_only' ? (
          <div className="mx-auto flex max-w-md justify-center">{details}</div>
        ) : variant === 'map_split' ? (
          <div className="grid items-stretch gap-[calc(var(--bf-gap)*1.5)] lg:grid-cols-[1.4fr_1fr]">
            <MapPanel ctx={ctx} tall />
            <div className="flex items-center">{details}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-[var(--bf-gap)]">
            <MapPanel ctx={ctx} tall={false} />
            <div className="bf-card !h-auto">{details}</div>
          </div>
        )}
      </div>
    </Section>
  );
}

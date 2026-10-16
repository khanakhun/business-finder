import type { SiteSpec } from '@bf/site-schema';
import { Icon } from '../icons/icon.tsx';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { cx, Section, SectionHead } from './shared.tsx';

type Network = NonNullable<SiteSpec['contact']['socials']>[number]['network'];

export const NETWORK_NAMES: Readonly<Record<Network, string>> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  x: 'X',
  tripadvisor: 'Tripadvisor',
  google: 'Google',
};

/** The business's profiles as links (icons with an accessible name, or labelled buttons). */
export function SocialList({
  ctx,
  variant,
  className,
}: {
  ctx: RenderContext;
  variant: 'icons' | 'buttons';
  className?: string | undefined;
}) {
  const socials = ctx.spec.contact.socials ?? [];
  const { Link } = ctx;
  return (
    <ul className={cx('flex flex-wrap gap-3', className)}>
      {socials.map((social) => (
        <li key={social.url}>
          <Link
            href={social.url}
            rel="me"
            aria-label={
              variant === 'icons' ? ctx.strings.profileOn(NETWORK_NAMES[social.network]) : undefined
            }
            className={
              variant === 'icons'
                ? 'bf-icon-btn border border-[var(--bf-line)] !rounded-full'
                : 'bf-btn bf-btn-secondary'
            }
          >
            <Icon name={social.network} size={variant === 'icons' ? 20 : 18} />
            {variant === 'buttons' ? NETWORK_NAMES[social.network] : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Links to the business's profiles, from `contact.socials`. */
export function SocialLinks({ block, ctx, tone }: BlockProps<'social_links'>) {
  const { props, variant } = block;
  if (!ctx.spec.contact.socials?.length) return null;
  return (
    <Section
      id={block.id}
      type="social_links"
      variant={variant}
      tone={tone}
      labelled={Boolean(props.heading)}
    >
      <div className="bf-container flex flex-col items-center">
        <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        <SocialList
          ctx={ctx}
          variant={variant === 'buttons' ? 'buttons' : 'icons'}
          className="justify-center"
        />
      </div>
    </Section>
  );
}

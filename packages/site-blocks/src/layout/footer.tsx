import { contactChannels } from '../blocks/contact.tsx';
import { HoursCompact } from '../blocks/hours.tsx';
import { AddressLines } from '../blocks/location.tsx';
import { SocialList } from '../blocks/social-links.tsx';
import type { RenderContext } from '../renderer/types.ts';
import { Credits } from './credits.tsx';

/** The footer: brand and tagline; with `columns`, contact, hours and the menu. */
export function Footer({ ctx }: { ctx: RenderContext }) {
  const { footer } = ctx.spec.layout;
  const { brand, contact, navigation } = ctx.spec;
  const { Link } = ctx;
  const tagline = footer.tagline ? <p className="bf-muted max-w-xs">{ctx.t(footer.tagline)}</p> : null;
  const socials =
    footer.showSocials && contact.socials?.length ? <SocialList ctx={ctx} variant="icons" /> : null;
  const rights = (
    <div className="flex flex-col gap-1">
      <p className="bf-muted text-sm">{ctx.strings.allRights(brand.name)}</p>
      <Credits ctx={ctx} />
    </div>
  );

  if (footer.variant === 'simple') {
    return (
      <footer className="border-t border-[var(--bf-hairline)]">
        <div className="bf-container flex flex-col items-center gap-5 py-10 text-center md:flex-row md:justify-between md:text-left">
          <div className="flex flex-col gap-1">
            <span className="bf-brand">{brand.name}</span>
            {tagline}
          </div>
          {socials}
          {rights}
        </div>
      </footer>
    );
  }

  const channels = contactChannels(ctx);
  const hours = footer.showHours ? contact.hours : undefined;
  const heading = 'bf-eyebrow mb-4';
  return (
    <footer className="border-t border-[var(--bf-hairline)] bg-surface">
      <div className="bf-container grid gap-10 py-[calc(var(--bf-section-space)*0.7)] sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-4">
          <span className="bf-brand">{brand.name}</span>
          {tagline}
          {socials}
        </div>
        {channels.length > 0 || contact.address ? (
          <div>
            <h2 className={heading}>{ctx.strings.contact}</h2>
            <div className="flex flex-col gap-3">
              <AddressLines ctx={ctx} />
              <ul className="flex flex-col">
                {channels.map((channel) => (
                  <li key={channel.key}>
                    <Link href={channel.href} className="bf-link bf-num inline-flex min-h-11 items-center">
                      {channel.value}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {hours ? (
          <div>
            <h2 className={heading}>{ctx.strings.hours}</h2>
            <div className="text-sm">
              <HoursCompact weekly={hours.weekly} ctx={ctx} />
            </div>
          </div>
        ) : null}
        {navigation.items.length > 0 ? (
          <nav aria-labelledby="bf-footer-menu">
            <h2 id="bf-footer-menu" className={heading}>
              {ctx.strings.menu}
            </h2>
            <ul className="flex flex-col">
              {navigation.items.map((item) => {
                const href = ctx.pageHref(item.pageId);
                return href ? (
                  <li key={item.pageId}>
                    <Link href={href} className="bf-link inline-flex min-h-11 items-center">
                      {ctx.t(item.label)}
                    </Link>
                  </li>
                ) : null;
              })}
            </ul>
          </nav>
        ) : null}
      </div>
      <div className="bf-container border-t border-[var(--bf-hairline)] py-6">{rights}</div>
    </footer>
  );
}

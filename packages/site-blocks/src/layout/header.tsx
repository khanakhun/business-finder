import type { SiteLocale } from '@bf/site-schema';
import { CtaButton, cx } from '../blocks/shared.tsx';
import { Icon } from '../icons/icon.tsx';
import type { RenderContext } from '../renderer/types.ts';

const MENU_ID = 'bf-mobile-menu';

/** The brand: the logo asset, or the business name in the heading font. */
function Brand({ ctx }: { ctx: RenderContext }) {
  const { layout, brand } = ctx.spec;
  const logo = ctx.image(layout.header.logoAssetId);
  const home = ctx.spec.pages.find((page) => page.slug === '') ?? ctx.spec.pages[0];
  const href = home ? (ctx.pageHref(home.id) ?? '/') : '/';
  const { Link, Image } = ctx;
  return (
    <Link href={href} className="bf-brand inline-flex min-h-11 items-center">
      {logo ? (
        <Image
          src={logo.src}
          sizes="12rem"
          alt={brand.name}
          width={logo.width}
          height={logo.height}
          priority
          className="h-10 w-auto max-w-[12rem] object-contain"
        />
      ) : (
        brand.name
      )}
    </Link>
  );
}

/** Links to this page in the site's other languages. */
function Languages({ ctx, className }: { ctx: RenderContext; className?: string }) {
  if (ctx.spec.locales.length < 2) return null;
  const { Link } = ctx;
  return (
    <ul className={cx('flex items-center gap-1', className)} aria-label={ctx.strings.languages}>
      {ctx.spec.locales.map((locale: SiteLocale) => {
        const href = ctx.pageHref(ctx.page.id, locale);
        if (!href) return null;
        const name = ctx.strings.languageNames[locale];
        return (
          <li key={locale}>
            <Link
              href={href}
              hrefLang={locale}
              lang={locale}
              aria-label={name}
              aria-current={locale === ctx.locale ? 'page' : undefined}
              className={cx(
                'bf-nav-link !min-h-11 px-2 text-xs font-semibold uppercase tracking-widest',
                locale !== ctx.locale && 'opacity-70 hover:opacity-100',
              )}
            >
              {locale}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function NavItems({
  ctx,
  className,
  itemClass,
}: {
  ctx: RenderContext;
  className?: string;
  itemClass?: string;
}) {
  const { Link } = ctx;
  return (
    <ul className={className}>
      {ctx.spec.navigation.items.map((item) => {
        const href = ctx.pageHref(item.pageId);
        if (!href) return null;
        return (
          <li key={item.pageId}>
            <Link
              href={href}
              aria-current={item.pageId === ctx.page.id ? 'page' : undefined}
              className={cx('bf-nav-link', itemClass)}
            >
              {ctx.t(item.label)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The site header: brand, menu, languages and the header action. On small screens the menu opens in a native
 * popover (no script; Esc and the close button dismiss it). `transparent` sits over a first full-image hero.
 */
export function Header({ ctx }: { ctx: RenderContext }) {
  const { header } = ctx.spec.layout;
  const first = ctx.page.blocks[0];
  const overImage =
    header.variant === 'transparent' &&
    first?.type === 'hero' &&
    first.variant === 'image_full' &&
    Boolean(ctx.image(first.props.imageAssetId));
  const variant = header.variant === 'transparent' && !overImage ? 'simple' : header.variant;
  const cta = header.showCta ? <CtaButton action={header.cta} ctx={ctx} className="max-lg:hidden" /> : null;
  const hasNav = ctx.spec.navigation.items.length > 0;
  const toggle = hasNav ? (
    <button
      type="button"
      className="bf-icon-btn lg:hidden"
      popoverTarget={MENU_ID}
      aria-label={ctx.strings.menu}
    >
      <Icon name="menu" size={24} />
    </button>
  ) : null;
  const nav = hasNav ? (
    <nav aria-label={ctx.strings.mainMenu} className="max-lg:hidden">
      <NavItems ctx={ctx} className="flex items-center gap-7" />
    </nav>
  ) : null;

  return (
    <header className="bf-header" data-variant={variant}>
      {variant === 'centered' ? (
        <div className="bf-container flex flex-col items-center gap-2 py-5">
          <div className="flex w-full items-center justify-between lg:justify-center">
            <span className="lg:hidden" aria-hidden="true" />
            <Brand ctx={ctx} />
            {toggle ?? <span className="lg:hidden" aria-hidden="true" />}
          </div>
          <div className="flex items-center gap-8 max-lg:hidden">
            {nav}
            <Languages ctx={ctx} />
            {cta}
          </div>
        </div>
      ) : (
        <div className="bf-container flex items-center justify-between gap-6 py-4">
          <Brand ctx={ctx} />
          <div className="flex items-center gap-6">
            {nav}
            <Languages ctx={ctx} className="max-lg:hidden" />
            {cta}
            {toggle}
          </div>
        </div>
      )}
      {hasNav ? (
        <div
          id={MENU_ID}
          popover="auto"
          role="dialog"
          className="bf-popover bf-menu-panel"
          aria-label={ctx.strings.menu}
        >
          <div className="bf-container flex items-center justify-between py-4">
            <Brand ctx={ctx} />
            <button
              type="button"
              className="bf-icon-btn"
              popoverTarget={MENU_ID}
              popoverTargetAction="hide"
              aria-label={ctx.strings.closeMenu}
            >
              <Icon name="close" size={24} />
            </button>
          </div>
          <nav aria-label={ctx.strings.mainMenu} className="bf-container flex flex-1 flex-col gap-10 py-8">
            <NavItems ctx={ctx} className="flex flex-col gap-2" itemClass="bf-h2 !text-[1.75rem]" />
            <Languages ctx={ctx} />
            {header.showCta ? <CtaButton action={header.cta} ctx={ctx} className="self-start" /> : null}
          </nav>
        </div>
      ) : null}
    </header>
  );
}

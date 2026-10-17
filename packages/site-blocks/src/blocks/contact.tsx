import { formatPhone, whatsappLink } from '../format/phone.ts';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/paths.ts';
import { ContactForm } from '../islands/contact-form.tsx';
import type { BlockProps, RenderContext } from '../renderer/types.ts';
import { cx, derivedId, Section, SectionHead } from './shared.tsx';

interface Channel {
  readonly key: string;
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly href: string;
}

/** The channels the block lists, among those the business publishes. */
export function contactChannels(
  ctx: RenderContext,
  wanted: { phone: boolean; email: boolean; whatsapp: boolean } = {
    phone: true,
    email: true,
    whatsapp: true,
  },
): Channel[] {
  const { phone, email, whatsapp } = ctx.spec.contact;
  const { strings } = ctx;
  const channels: Channel[] = [];
  if (wanted.phone && phone)
    channels.push({
      key: 'phone',
      icon: 'phone',
      label: strings.phone,
      value: formatPhone(phone.value, ctx.country),
      href: `tel:${phone.value}`,
    });
  if (wanted.email && email)
    channels.push({
      key: 'email',
      icon: 'mail',
      label: strings.email,
      value: email.value,
      href: `mailto:${email.value}`,
    });
  if (wanted.whatsapp && whatsapp)
    channels.push({
      key: 'whatsapp',
      icon: 'message',
      label: strings.whatsapp,
      value: formatPhone(whatsapp.value, ctx.country),
      href: whatsappLink(whatsapp.value),
    });
  return channels;
}

/** How to reach the business: its channels, and the contact form when the site offers it. */
export function Contact({ block, ctx, tone }: BlockProps<'contact'>) {
  const { props, variant } = block;
  const channels = contactChannels(ctx, props.channels);
  const form = props.showForm && ctx.spec.settings.contactForm.enabled;
  const { Link } = ctx;
  const list =
    channels.length > 0 ? (
      <ul
        className={cx(
          'flex flex-col gap-4',
          variant === 'centered' && 'sm:flex-row sm:flex-wrap sm:justify-center sm:gap-6',
        )}
      >
        {channels.map((channel) => (
          <li key={channel.key}>
            <Link href={channel.href} className="group flex min-h-11 items-center gap-4 no-underline">
              <span className="bf-icon-badge shrink-0">
                <Icon name={channel.icon} />
              </span>
              <span className="flex flex-col text-left">
                <span className="bf-eyebrow">{channel.label}</span>
                <span className="bf-num font-medium underline-offset-4 group-hover:underline">
                  {channel.value}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    ) : null;
  const contactForm = form ? (
    <ContactForm
      formId={derivedId(block.id, 'form')}
      action={ctx.options.preview ? ctx.options.previewLeadForm?.action : ctx.options.contactFormAction}
      {...(ctx.options.preview && ctx.options.previewLeadForm
        ? { hidden: ctx.options.previewLeadForm.hidden, notice: ctx.options.previewLeadForm.notice }
        : {})}
      strings={ctx.strings.form}
      className={cx(variant === 'split' && 'bf-card !h-auto')}
    />
  ) : null;

  return (
    <Section id={block.id} type="contact" variant={variant} tone={tone} labelled>
      <div className="bf-container">
        {variant === 'split' ? (
          <div className={cx('grid gap-[calc(var(--bf-gap)*2)]', contactForm && 'lg:grid-cols-[1fr_1.2fr]')}>
            <div className="flex flex-col gap-8 [&_.bf-section-head]:!mb-0">
              <SectionHead
                blockId={block.id}
                heading={props.heading}
                intro={props.intro}
                align="start"
                ctx={ctx}
              />
              {list}
            </div>
            {contactForm}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-10">
            <SectionHead blockId={block.id} heading={props.heading} intro={props.intro} ctx={ctx} />
            {list}
            {contactForm ? <div className="w-full max-w-2xl">{contactForm}</div> : null}
          </div>
        )}
      </div>
    </Section>
  );
}

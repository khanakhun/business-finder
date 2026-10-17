import {
  GlobeIcon,
  LayoutTemplateIcon,
  MailIcon,
  MessageCircleIcon,
  PhoneIcon,
  SparklesIcon,
} from 'lucide-react';
import { enrichNow } from '@/features/enrichment/api.ts';
import { openComposer } from '@/features/outreach/composer/store.ts';
import { safeWebUrl } from '@/features/search/safe-url.ts';
import { getToast } from '@/lib/toast.tsx';
import { quickActions } from './registry.ts';

/** `wa.me` takes the international number without `+` or separators. */
export function whatsAppUrl(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 6 ? `https://wa.me/${digits}` : null;
}

let registered = false;

/** The quick actions BF-024 ships (idempotent). Placeholders are replaced by id by the tickets that own them. */
export function registerDefaultQuickActions(): void {
  if (registered) return;
  registered = true;
  quickActions.register({
    id: 'business.open-website',
    labelKey: 'business.actions.openWebsite',
    icon: GlobeIcon,
    order: 10,
    hidden: ({ business }) => safeWebUrl(business.websiteUrl) === null,
    href: ({ business }) => safeWebUrl(business.websiteUrl),
  });
  quickActions.register({
    id: 'business.call',
    labelKey: 'business.actions.call',
    icon: PhoneIcon,
    order: 20,
    hidden: ({ business }) => !business.primaryPhone,
    disabledReason: ({ crm }) => (crm.doNotContact ? 'business.actions.doNotContact' : null),
    href: ({ business }) => `tel:${business.primaryPhone?.replace(/[^\d+]/g, '')}`,
  });
  quickActions.register({
    // BF-057 replaces this with a prepared message.
    id: 'business.whatsapp',
    labelKey: 'business.actions.whatsApp',
    icon: MessageCircleIcon,
    order: 30,
    hidden: ({ business }) => whatsAppUrl(business.primaryPhone) === null,
    disabledReason: ({ crm }) => (crm.doNotContact ? 'business.actions.doNotContact' : null),
    href: ({ business }) => whatsAppUrl(business.primaryPhone),
  });
  quickActions.register({
    // BF-027: every available step now; the Website tab picks steps and re-runs.
    id: 'enrichment.enrich',
    labelKey: 'business.actions.enrich',
    icon: SparklesIcon,
    order: 40,
    permission: 'business:write',
    run: async ({ business }, ui) => {
      const toast = await getToast();
      try {
        await enrichNow(business.id);
        toast.success(ui.t('enrichment.started'));
      } catch {
        toast.error(ui.t('enrichment.startFailed'));
      }
    },
  });
  quickActions.register({
    id: 'sites.generate',
    labelKey: 'business.actions.generateSite',
    icon: LayoutTemplateIcon,
    order: 50,
    permission: 'sites:generate',
    // The create flow with this one business (BF-046).
    href: ({ business }) => `/generation/new?ids=${business.id}`,
  });
  quickActions.register({
    id: 'outreach.send-email',
    labelKey: 'business.actions.sendEmail',
    icon: MailIcon,
    order: 60,
    permission: 'outreach:send',
    // BF-051: opens the composer (sending is BF-052's).
    disabledReason: ({ crm }) => (crm.doNotContact ? 'business.actions.doNotContact' : null),
    run: ({ business }) => openComposer({ businessId: business.id, businessName: business.displayName }),
  });
}

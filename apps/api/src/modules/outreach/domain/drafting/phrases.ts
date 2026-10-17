import type { Offer, PainSignalTag } from '@bf/contracts';

// Short phrases a draft or template may use (BF-051): the offer, and review themes in general terms (never a quote).

export const OFFER_LABELS: Record<Offer, { en: string; fr: string }> = {
  new_website: { en: 'a new website', fr: 'un nouveau site' },
  website_redesign: { en: 'a refreshed website', fr: 'un site rafraîchi' },
  ai_receptionist: { en: 'an AI receptionist', fr: 'un accueil téléphonique assisté par IA' },
  booking_system: { en: 'online booking', fr: 'la réservation en ligne' },
  local_seo: {
    en: 'better local search visibility',
    fr: 'une meilleure visibilité dans les recherches locales',
  },
};

export const THEME_PHRASES: Partial<Record<PainSignalTag, { en: string; fr: string }>> = {
  booking_friction: { en: 'booking is not always easy', fr: 'réserver n’est pas toujours simple' },
  unreachable_by_phone: {
    en: 'it can be hard to reach you by phone',
    fr: 'il est parfois difficile de vous joindre par téléphone',
  },
  slow_or_no_reply: { en: 'replies can take a while', fr: 'les réponses peuvent tarder' },
  website_broken_or_outdated: {
    en: 'the website could be more up to date',
    fr: 'le site pourrait être plus à jour',
  },
  no_online_menu_or_prices: {
    en: 'menus or prices are hard to find online',
    fr: 'la carte ou les prix sont difficiles à trouver en ligne',
  },
  hard_to_find_info: {
    en: 'some practical information is hard to find',
    fr: 'certaines informations pratiques sont difficiles à trouver',
  },
  language_barrier: {
    en: 'information in other languages would help visitors',
    fr: 'des informations dans d’autres langues aideraient les visiteurs',
  },
  payment_friction: { en: 'paying could be simpler', fr: 'le paiement pourrait être plus simple' },
  long_wait_times: { en: 'waiting times come up', fr: 'l’attente revient parfois' },
  inconsistent_hours: {
    en: 'opening hours are not always clear',
    fr: 'les horaires ne sont pas toujours clairs',
  },
  poor_communication: {
    en: 'communication could be smoother',
    fr: 'la communication pourrait être plus fluide',
  },
  positive_strong_reputation: {
    en: 'customers speak very highly of you',
    fr: 'vos clients parlent très bien de vous',
  },
};

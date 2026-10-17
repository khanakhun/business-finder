import type { Locale, NotificationType } from '@bf/contracts';

// Email copy for notifications (the dashboard has its own messages under `notifications.types.*`). `{name}`-style
// placeholders are filled from the notification's params.

type Copy = { readonly title: string; readonly body: string };

const COPY: Record<Locale, Record<NotificationType, Copy>> = {
  en: {
    reply_received: { title: 'New reply from {business}', body: 'A prospect answered your email.' },
    lead_captured: { title: 'New lead on {site}', body: 'Someone left their details on a preview site.' },
    lead_opted_out: {
      title: '{business} asked not to be contacted',
      body: 'Do-not-contact is set; the preview is taken down if they asked.',
    },
    batch_completed: {
      title: 'Site generation finished',
      body: '{count} preview sites are ready to review.',
    },
    site_needs_review: {
      title: 'A generated site needs review',
      body: '{business}: the site was kept unpublished ({reason}).',
    },
    discovery_completed: { title: 'Discovery finished', body: '{count} businesses found.' },
    mailbox_paused: {
      title: 'Mailbox paused: {mailbox}',
      body: 'Sending stopped to protect deliverability.',
    },
    member_joined: { title: '{name} joined the workspace', body: 'They accepted their invitation.' },
    system_test: { title: 'Test notification', body: 'Notifications work.' },
  },
  fr: {
    reply_received: {
      title: 'Nouvelle réponse de {business}',
      body: 'Un prospect a répondu à votre e-mail.',
    },
    lead_captured: {
      title: 'Nouveau contact sur {site}',
      body: 'Quelqu’un a laissé ses coordonnées sur un site d’aperçu.',
    },
    lead_opted_out: {
      title: '{business} ne souhaite pas être contactée',
      body: 'Ne pas contacter est activé ; l’aperçu est retiré si demandé.',
    },
    batch_completed: { title: 'Génération de sites terminée', body: '{count} sites d’aperçu sont prêts.' },
    site_needs_review: {
      title: 'Un site généré est à revoir',
      body: '{business} : le site n’a pas été publié ({reason}).',
    },
    discovery_completed: { title: 'Découverte terminée', body: '{count} entreprises trouvées.' },
    mailbox_paused: {
      title: 'Boîte d’envoi en pause : {mailbox}',
      body: 'Les envois sont suspendus pour protéger la délivrabilité.',
    },
    member_joined: {
      title: '{name} a rejoint l’espace de travail',
      body: 'Cette personne a accepté son invitation.',
    },
    system_test: { title: 'Notification de test', body: 'Les notifications fonctionnent.' },
  },
};

const fill = (text: string, params: Readonly<Record<string, string | number>>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));

export function notificationCopy(
  type: NotificationType,
  locale: Locale,
  params: Readonly<Record<string, string | number>>,
): Copy {
  const copy = COPY[locale][type];
  return { title: fill(copy.title, params), body: fill(copy.body, params) };
}

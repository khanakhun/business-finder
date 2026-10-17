import type { SiteLocale } from '@bf/site-schema';

// Texts of the preview's lead pages (BF-048): English and French; the other site languages read English for now.

export interface LeadStrings {
  readonly claimTitle: (business: string) => string;
  readonly claimIntro: (agency: string, business: string) => string;
  readonly name: string;
  readonly phone: string;
  readonly whatsapp: string;
  readonly email: string;
  readonly message: string;
  readonly preferredChannel: string;
  readonly channels: { phone: string; whatsapp: string; email: string };
  readonly preferredTime: string;
  readonly optional: string;
  readonly consent: (agency: string) => string;
  readonly privacyLink: string;
  readonly send: string;
  readonly sending: string;
  readonly claimSent: string;
  readonly claimNext: (agency: string) => string;
  readonly whatsappAgency: (agency: string) => string;
  readonly whatsappText: (business: string) => string;
  readonly optOutTitle: string;
  readonly optOutIntro: (agency: string, business: string) => string;
  readonly stopContact: string;
  readonly removePreview: string;
  readonly reason: string;
  readonly optOutConfirm: string;
  readonly optOutSent: string;
  readonly optOutWhat: string;
  readonly privacyTitle: (agency: string) => string;
  readonly privacyBody: (agency: string) => readonly string[];
  readonly backToPreview: string;
  readonly rightsTitle: string;
  readonly rightsIntro: (agency: string) => string;
  readonly rightsType: string;
  readonly rightsTypes: {
    access: string;
    erasure: string;
    objection: string;
    rectification: string;
    restriction: string;
  };
  readonly rightsSend: string;
  readonly rightsSent: (agency: string) => string;
  readonly contactNotice: (agency: string, business: string) => string;
  readonly failed: string;
}

const RIGHTS_EN = {
  rightsTitle: 'Exercise your rights',
  rightsIntro: (agency: string) =>
    `Ask ${agency} for a copy of the data about you, its correction or deletion, or to stop using it. ${agency} answers within one month after checking it is you.`,
  rightsType: 'Your request',
  rightsTypes: {
    access: 'A copy of my data',
    erasure: 'Delete my data',
    objection: 'Stop using my data for prospecting',
    rectification: 'Correct my data',
    restriction: 'Limit how my data is used',
  },
  rightsSend: 'Send my request',
  rightsSent: (agency: string) => `Your request was sent. ${agency} will contact you to confirm it is you.`,
};

const RIGHTS_FR = {
  rightsTitle: 'Exercer vos droits',
  rightsIntro: (agency: string) =>
    `Demandez à ${agency} une copie de vos données, leur correction ou leur suppression, ou l’arrêt de leur utilisation. ${agency} répond dans un délai d’un mois après avoir vérifié votre identité.`,
  rightsType: 'Votre demande',
  rightsTypes: {
    access: 'Une copie de mes données',
    erasure: 'Supprimer mes données',
    objection: 'Ne plus utiliser mes données pour la prospection',
    rectification: 'Corriger mes données',
    restriction: 'Limiter l’utilisation de mes données',
  },
  rightsSend: 'Envoyer ma demande',
  rightsSent: (agency: string) =>
    `Votre demande a été envoyée. ${agency} vous contactera pour vérifier votre identité.`,
};

const EN: LeadStrings = {
  ...RIGHTS_EN,
  claimTitle: (business) => `Is ${business} your business?`,
  claimIntro: (agency, business) =>
    `${agency} made this preview website for ${business}. Leave your details and ${agency} will get back to you — there is no commitment.`,
  name: 'Your name',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  email: 'Email',
  message: 'Message',
  preferredChannel: 'How should we reach you?',
  channels: { phone: 'Phone call', whatsapp: 'WhatsApp', email: 'Email' },
  preferredTime: 'Best time to reach you',
  optional: 'optional',
  consent: (agency) => `I agree that ${agency} contacts me about this website.`,
  privacyLink: 'How we use your details',
  send: 'Send',
  sending: 'Sending…',
  claimSent: 'Thank you — your message was sent.',
  claimNext: (agency) => `${agency} will contact you shortly, usually within one business day.`,
  whatsappAgency: (agency) => `Message ${agency} on WhatsApp`,
  whatsappText: (business) => `Hello, I saw the preview website for ${business}.`,
  optOutTitle: 'Don’t contact me',
  optOutIntro: (agency, business) =>
    `${agency} made this preview for ${business} without being asked. If you are not interested, tell us here.`,
  stopContact: 'Stop contacting us',
  removePreview: 'Remove this preview',
  reason: 'Anything you want to tell us?',
  optOutConfirm: 'Confirm',
  optOutSent: 'Done — we will not contact you again.',
  optOutWhat:
    'Your business is marked “do not contact” right away. If you asked, the preview is taken offline within minutes.',
  privacyTitle: (agency) => `Privacy — ${agency}`,
  privacyBody: (agency) => [
    `${agency} built this preview website to show what a new site could look like for the business. It is not published by the business.`,
    'When you send a form on this site, we keep the details you give (name, phone, WhatsApp, email, message, preferences) to answer you about this website. The legal basis is your consent, or for an opt-out our legal obligation to respect it.',
    'We keep these details for up to 24 months (spam for 30 days), then delete them. We never store your IP address, and we do not use third-party trackers on this site.',
    `You can ask to see, correct or delete your details, or withdraw your consent, at any time by contacting ${agency}.`,
  ],
  backToPreview: 'Back to the preview',
  contactNotice: (agency, business) => `Demo form — messages go to ${agency}, not to ${business}.`,
  failed: 'Sending failed. Please try again.',
};

const FR: LeadStrings = {
  ...RIGHTS_FR,
  claimTitle: (business) => `${business}, c’est votre entreprise ?`,
  claimIntro: (agency, business) =>
    `${agency} a réalisé cet aperçu de site pour ${business}. Laissez vos coordonnées et ${agency} vous recontacte — sans engagement.`,
  name: 'Votre nom',
  phone: 'Téléphone',
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  message: 'Message',
  preferredChannel: 'Comment vous joindre ?',
  channels: { phone: 'Appel', whatsapp: 'WhatsApp', email: 'E-mail' },
  preferredTime: 'Meilleur moment pour vous joindre',
  optional: 'facultatif',
  consent: (agency) => `J’accepte que ${agency} me contacte au sujet de ce site.`,
  privacyLink: 'Comment nous utilisons vos données',
  send: 'Envoyer',
  sending: 'Envoi…',
  claimSent: 'Merci — votre message a bien été envoyé.',
  claimNext: (agency) => `${agency} vous recontacte rapidement, en général sous un jour ouvré.`,
  whatsappAgency: (agency) => `Écrire à ${agency} sur WhatsApp`,
  whatsappText: (business) => `Bonjour, j’ai vu l’aperçu du site de ${business}.`,
  optOutTitle: 'Ne plus me contacter',
  optOutIntro: (agency, business) =>
    `${agency} a réalisé cet aperçu pour ${business} sans demande de votre part. Si cela ne vous intéresse pas, dites-le ici.`,
  stopContact: 'Ne plus nous contacter',
  removePreview: 'Retirer cet aperçu',
  reason: 'Souhaitez-vous ajouter quelque chose ?',
  optOutConfirm: 'Confirmer',
  optOutSent: 'C’est fait — nous ne vous contacterons plus.',
  optOutWhat:
    'Votre entreprise est immédiatement marquée « ne pas contacter ». Si vous l’avez demandé, l’aperçu est retiré en quelques minutes.',
  privacyTitle: (agency) => `Confidentialité — ${agency}`,
  privacyBody: (agency) => [
    `${agency} a réalisé cet aperçu de site pour montrer à quoi pourrait ressembler un nouveau site pour l’entreprise. Il n’est pas publié par l’entreprise.`,
    'Lorsque vous envoyez un formulaire sur ce site, nous conservons les informations que vous donnez (nom, téléphone, WhatsApp, e-mail, message, préférences) pour vous répondre au sujet de ce site. La base légale est votre consentement, ou pour un refus de contact notre obligation de le respecter.',
    'Nous conservons ces informations 24 mois au plus (30 jours pour le spam), puis nous les supprimons. Nous ne conservons jamais votre adresse IP et n’utilisons aucun traceur tiers sur ce site.',
    `Vous pouvez à tout moment demander à consulter, corriger ou supprimer vos informations, ou retirer votre consentement, en contactant ${agency}.`,
  ],
  backToPreview: 'Retour à l’aperçu',
  contactNotice: (agency, business) =>
    `Formulaire de démonstration — les messages vont à ${agency}, pas à ${business}.`,
  failed: 'L’envoi a échoué. Veuillez réessayer.',
};

export function leadStrings(locale: SiteLocale): LeadStrings {
  return locale === 'fr' ? FR : EN;
}

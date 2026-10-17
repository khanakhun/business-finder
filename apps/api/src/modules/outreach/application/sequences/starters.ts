import type { SaveSequenceRequest } from '@bf/contracts';

// The starter sequences (BF-053, EN/FR), created in a workspace on request. "Preview follow-up": the first email is
// sent by hand from the composer (attach the sequence after it); a follow-up after 3 business days that depends on
// whether the preview was opened; a polite close after 5 more. "Audit-led": no preview, the findings carry it.

type Locale = 'en' | 'fr';

const COPY = {
  en: {
    preview: 'Preview follow-up',
    audit: 'Audit-led follow-up',
    viewed:
      'They opened the preview: a short, friendly follow-up asking what they thought of it and offering a 15-minute call. Do not mention tracking.',
    notViewed:
      'They have not looked yet: a two-line follow-up reminding them of the preview made for them, with its link, and one simple question.',
    close:
      'A polite last message: no pressure, you will not write again about this, the preview stays available a few days, they can reply anytime.',
    auditFirst:
      'First email based on one or two measured findings about their website, constructive, with a simple question. No preview link.',
    auditFollow: 'A short follow-up on the first email: one more concrete benefit, one simple question.',
    call: 'Call to follow up on the emails',
  },
  fr: {
    preview: 'Relance après aperçu',
    audit: 'Relance basée sur l’audit',
    viewed:
      'Ils ont ouvert l’aperçu : une relance courte et cordiale pour leur demander ce qu’ils en ont pensé et proposer un appel de 15 minutes. Ne pas évoquer de suivi.',
    notViewed:
      'Ils n’ont pas encore regardé : une relance de deux lignes rappelant l’aperçu préparé pour eux, avec son lien, et une question simple.',
    close:
      'Un dernier message courtois : sans pression, vous ne reviendrez plus sur le sujet, l’aperçu reste disponible quelques jours, ils peuvent répondre quand ils veulent.',
    auditFirst:
      'Premier e-mail fondé sur un ou deux constats mesurés sur leur site, constructif, avec une question simple. Pas de lien vers un aperçu.',
    auditFollow: 'Une courte relance du premier e-mail : un bénéfice concret de plus, une question simple.',
    call: 'Appeler pour faire suite aux e-mails',
  },
} as const;

export function starterSequences(locale: Locale): SaveSequenceRequest[] {
  const t = COPY[locale];
  const calendars = locale === 'fr' ? (['FR', 'BL'] as const) : (['US'] as const);
  const settings = {
    calendars: [...calendars],
    maxEmails: 3,
    minGapBusinessDays: 2,
    approval: 'auto_when_permitted' as const,
    stopOnPreviewLead: true,
  };
  return [
    {
      name: t.preview,
      offer: 'website_redesign',
      settings,
      steps: [
        {
          id: 'first',
          kind: 'email',
          wait: { businessDays: 0, preferredLocalTime: '09:30' },
          condition: 'always',
          threading: 'new_thread',
          variants: [
            {
              id: 'a',
              weight: 100,
              templateId: null,
              instructions: 'First email presenting the preview made for them.',
            },
          ],
        },
        {
          id: 'follow-viewed',
          kind: 'email',
          wait: { businessDays: 3, preferredLocalTime: '09:30' },
          condition: 'previewViewed',
          variants: [{ id: 'a', weight: 100, templateId: null, instructions: t.viewed }],
        },
        {
          id: 'follow-not-viewed',
          kind: 'email',
          wait: { businessDays: 0, preferredLocalTime: '09:30' },
          condition: 'previewNotViewed',
          variants: [{ id: 'a', weight: 100, templateId: null, instructions: t.notViewed }],
        },
        {
          id: 'close',
          kind: 'email',
          wait: { businessDays: 5, preferredLocalTime: '10:00' },
          condition: 'always',
          variants: [{ id: 'a', weight: 100, templateId: null, instructions: t.close }],
        },
      ],
    },
    {
      name: t.audit,
      offer: 'website_redesign',
      settings,
      steps: [
        {
          id: 'first',
          kind: 'email',
          wait: { businessDays: 0, preferredLocalTime: '09:30' },
          condition: 'always',
          threading: 'new_thread',
          variants: [{ id: 'a', weight: 100, templateId: null, instructions: t.auditFirst }],
        },
        {
          id: 'follow',
          kind: 'email',
          wait: { businessDays: 4, preferredLocalTime: '09:30' },
          condition: 'always',
          variants: [{ id: 'a', weight: 100, templateId: null, instructions: t.auditFollow }],
        },
        {
          id: 'call',
          kind: 'task_call',
          wait: { businessDays: 3, preferredLocalTime: null },
          condition: 'always',
          taskTitle: t.call,
        },
      ],
    },
  ];
}

import type { Locale } from '@bf/contracts';

/** Copy for system emails, EN/FR (DOMAIN.md: the sales partner and operator work in both languages). */
export const MESSAGES = {
  en: {
    footer: 'You received this email because of activity on your Business Finder account.',
    notification: {
      open: 'Open in Business Finder',
      manage: 'Choose which notifications you receive by email in Settings → Notifications.',
    },
    ignore: 'If you did not request this, you can ignore this email.',
    verify: {
      subject: 'Confirm your email address',
      heading: 'Confirm your email',
      body: (name: string) => `Hi ${name}, confirm your email address to finish setting up your account.`,
      cta: 'Confirm email',
      expiry: 'This link expires in 24 hours.',
    },
    reset: {
      subject: 'Reset your password',
      heading: 'Reset your password',
      body: (name: string) => `Hi ${name}, use the button below to choose a new password.`,
      cta: 'Choose a new password',
      expiry: 'This link expires in 1 hour. Signing in elsewhere will end your other sessions.',
    },
    invite: {
      subject: (org: string) => `You're invited to ${org} on Business Finder`,
      heading: (org: string) => `Join ${org}`,
      body: (inviter: string, org: string, role: string) =>
        `${inviter} invited you to join ${org} as ${role}.`,
      cta: 'Accept invitation',
      expiry: 'The invitation expires in 7 days.',
    },
    magicLink: {
      subject: 'Your website portal sign-in link',
      heading: 'Sign in to your website portal',
      body: 'Use this button to sign in. The link works once and expires in 15 minutes.',
      cta: 'Sign in',
    },
    twoFactor: {
      subject: 'Two-factor authentication is on',
      heading: 'Two-factor authentication enabled',
      body: (name: string) =>
        `Hi ${name}, two-factor authentication is now required when you sign in. Keep your backup codes safe.`,
      warning: 'If this was not you, reset your password and contact your workspace owner now.',
    },
    roles: { owner: 'an owner', admin: 'an admin', member: 'a member', viewer: 'a viewer' } as Record<
      string,
      string
    >,
  },
  fr: {
    footer: 'Vous recevez cet e-mail suite à une activité sur votre compte Business Finder.',
    notification: {
      open: 'Ouvrir dans Business Finder',
      manage: 'Choisissez les notifications reçues par e-mail dans Paramètres → Notifications.',
    },
    ignore: "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.",
    verify: {
      subject: 'Confirmez votre adresse e-mail',
      heading: 'Confirmez votre e-mail',
      body: (name: string) => `Bonjour ${name}, confirmez votre adresse e-mail pour finaliser votre compte.`,
      cta: "Confirmer l'e-mail",
      expiry: 'Ce lien expire dans 24 heures.',
    },
    reset: {
      subject: 'Réinitialisez votre mot de passe',
      heading: 'Réinitialisez votre mot de passe',
      body: (name: string) =>
        `Bonjour ${name}, utilisez le bouton ci-dessous pour choisir un nouveau mot de passe.`,
      cta: 'Choisir un nouveau mot de passe',
      expiry: 'Ce lien expire dans 1 heure. Vos autres sessions seront fermées.',
    },
    invite: {
      subject: (org: string) => `Invitation à rejoindre ${org} sur Business Finder`,
      heading: (org: string) => `Rejoindre ${org}`,
      body: (inviter: string, org: string, role: string) =>
        `${inviter} vous invite à rejoindre ${org} en tant que ${role}.`,
      cta: "Accepter l'invitation",
      expiry: "L'invitation expire dans 7 jours.",
    },
    magicLink: {
      subject: 'Votre lien de connexion à l’espace de votre site',
      heading: 'Connexion à l’espace de votre site',
      body: 'Utilisez ce bouton pour vous connecter. Le lien ne sert qu’une fois et expire dans 15 minutes.',
      cta: 'Se connecter',
    },
    twoFactor: {
      subject: "L'authentification à deux facteurs est activée",
      heading: 'Authentification à deux facteurs activée',
      body: (name: string) =>
        `Bonjour ${name}, un second facteur est désormais demandé à la connexion. Conservez vos codes de secours.`,
      warning:
        "Si ce n'était pas vous, réinitialisez votre mot de passe et prévenez le propriétaire de l'espace.",
    },
    roles: { owner: 'propriétaire', admin: 'administrateur', member: 'membre', viewer: 'lecteur' } as Record<
      string,
      string
    >,
  },
} satisfies Record<Locale, unknown>;

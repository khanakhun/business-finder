import type { MailboxProviderKind } from '@bf/contracts';

// What each mailbox provider needs in DNS (BF-056): the SPF include, the DKIM selectors to probe, and where the person
// turns DKIM on. Exact for Google Workspace and Microsoft 365; common SMTP hosts by their MX; generic otherwise.

export interface ProviderPreset {
  readonly name: string;
  readonly spfInclude: string | null;
  readonly dkimSelectors: readonly string[];
  readonly dkimHow: { readonly en: string; readonly fr: string };
}

export const PRESETS: Record<'gmail' | 'graph', ProviderPreset> = {
  gmail: {
    name: 'Google Workspace',
    spfInclude: '_spf.google.com',
    dkimSelectors: ['google'],
    dkimHow: {
      en: 'In the Google Admin console: Apps → Google Workspace → Gmail → Authenticate email → Generate new record (2048-bit), publish the TXT record google._domainkey, then Start authentication.',
      fr: 'Dans la console d’administration Google : Applications → Google Workspace → Gmail → Authentifier les e-mails → Générer un nouvel enregistrement (2048 bits), publiez l’enregistrement TXT google._domainkey, puis Lancer l’authentification.',
    },
  },
  graph: {
    name: 'Microsoft 365',
    spfInclude: 'spf.protection.outlook.com',
    dkimSelectors: ['selector1', 'selector2'],
    dkimHow: {
      en: 'In the Microsoft Defender portal: Email & collaboration → Policies → Email authentication settings → DKIM, select the domain, publish the two CNAME records it shows (selector1._domainkey and selector2._domainkey), then enable signing.',
      fr: 'Dans le portail Microsoft Defender : E-mail et collaboration → Stratégies → Paramètres d’authentification des e-mails → DKIM, choisissez le domaine, publiez les deux enregistrements CNAME indiqués (selector1._domainkey et selector2._domainkey), puis activez la signature.',
    },
  },
};

/** Common SMTP hosts, recognized by their MX (the SPF include they document). */
const SMTP_HOSTS: { readonly mx: RegExp; readonly preset: ProviderPreset }[] = [
  {
    mx: /\.ovh\.net\.?$/i,
    preset: {
      name: 'OVHcloud',
      spfInclude: 'mx.ovh.com',
      dkimSelectors: ['ovhmo', 'ovhex'],
      dkimHow: generic(),
    },
  },
  {
    mx: /\.zoho\.(eu|com)\.?$/i,
    preset: {
      name: 'Zoho Mail',
      spfInclude: 'zoho.eu',
      dkimSelectors: ['zmail', 'zoho'],
      dkimHow: generic(),
    },
  },
  {
    mx: /\.gandi\.net\.?$/i,
    preset: {
      name: 'Gandi',
      spfInclude: '_mailcust.gandi.net',
      dkimSelectors: ['gm1', 'gm2'],
      dkimHow: generic(),
    },
  },
  {
    mx: /\.(ionos|kundenserver)\.(fr|de|com)\.?$/i,
    preset: {
      name: 'IONOS',
      spfInclude: '_spf-eu.ionos.com',
      dkimSelectors: ['s1-ionos', 's2-ionos'],
      dkimHow: generic(),
    },
  },
];

function generic() {
  return {
    en: 'In your email host’s admin, turn on DKIM signing for the domain and publish the record it gives you.',
    fr: 'Dans l’administration de votre hébergeur e-mail, activez la signature DKIM pour le domaine et publiez l’enregistrement fourni.',
  };
}

const GENERIC_SELECTORS = ['default', 'dkim', 'mail', 's1', 's2', 'k1', 'selector1', 'selector2', 'google'];

export function presetFor(provider: MailboxProviderKind, mxHosts: readonly string[]): ProviderPreset {
  if (provider === 'gmail' || provider === 'graph') return PRESETS[provider];
  for (const host of SMTP_HOSTS) if (mxHosts.some((mx) => host.mx.test(mx))) return host.preset;
  return { name: 'your email host', spfInclude: null, dkimSelectors: GENERIC_SELECTORS, dkimHow: generic() };
}

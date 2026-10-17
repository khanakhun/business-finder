// The live site's legal notice and privacy notice (BF-062), generated from the legal profile. Templates, not legal
// advice: the agency confirms them once (`needs_legal_review`), and a lawyer should review them per jurisdiction.

export interface LegalStrings {
  readonly legalTitle: string;
  readonly privacyTitle: string;
  readonly backHome: string;
  readonly publisher: string;
  readonly legalName: string;
  readonly legalForm: string;
  readonly registration: string;
  readonly vat: string;
  readonly address: string;
  readonly phone: string;
  readonly email: string;
  readonly director: string;
  readonly host: string;
  readonly hostIntro: (host: string) => string;
  readonly ip: string;
  readonly ipBody: (business: string) => string;
  readonly contact: string;
  readonly contactBody: (email: string) => string;
  readonly controllerTitle: string;
  readonly controllerBody: (business: string) => string;
  readonly processorTitle: string;
  readonly processorBody: (host: string) => string;
  readonly purposeTitle: string;
  readonly purposeBody: string;
  readonly basisTitle: string;
  readonly basisBody: string;
  readonly retentionTitle: string;
  readonly retentionBody: string;
  readonly rightsTitle: string;
  readonly rightsBody: (email: string) => string;
  readonly cookiesTitle: string;
  readonly cookiesBody: string;
  readonly dpo: (contact: string) => string;
  readonly missing: string;
  readonly updated: (date: string) => string;
  readonly footerLegal: string;
  readonly footerPrivacy: string;
  readonly formNotice: (business: string) => string;
}

export const LEGAL_EN: LegalStrings = {
  legalTitle: 'Legal notice',
  privacyTitle: 'Privacy notice',
  backHome: 'Back to the website',
  publisher: 'Publisher',
  legalName: 'Name',
  legalForm: 'Legal form',
  registration: 'Registration',
  vat: 'VAT number',
  address: 'Address',
  phone: 'Phone',
  email: 'Email',
  director: 'Publication director',
  host: 'Hosting',
  hostIntro: (host) => `This website is designed and hosted by ${host}.`,
  ip: 'Intellectual property and credits',
  ipBody: (business) =>
    `The content of this website belongs to ${business} or is used with permission. Photographs from stock libraries are credited where they appear.`,
  contact: 'Contact',
  contactBody: (email) => `For any question about this website, write to ${email}.`,
  controllerTitle: 'Who is responsible',
  controllerBody: (business) =>
    `${business} is responsible for the personal data sent through this website (the controller).`,
  processorTitle: 'Who processes it',
  processorBody: (host) =>
    `${host} hosts the website and its contact form on behalf of the business (the processor).`,
  purposeTitle: 'What for',
  purposeBody: 'Answering the messages you send through the contact form. Nothing else.',
  basisTitle: 'Legal basis',
  basisBody: 'Your request: you write to the business so that it answers you.',
  retentionTitle: 'How long',
  retentionBody: 'Messages are kept as long as needed to answer them, and at most 24 months.',
  rightsTitle: 'Your rights',
  rightsBody: (email) =>
    `You can access, correct or delete your data, object to its processing or ask for its restriction by writing to ${email}. You can also complain to your data protection authority.`,
  cookiesTitle: 'Cookies and statistics',
  cookiesBody:
    'This website sets no cookie and loads no third-party tracker. Visits are counted anonymously, without storing your IP address.',
  dpo: (contact) => `Data protection contact: ${contact}.`,
  missing: 'This information is being completed.',
  updated: (date) => `Last updated: ${date}.`,
  footerLegal: 'Legal notice',
  footerPrivacy: 'Privacy',
  formNotice: (business) => `Your message is sent to ${business}. See the privacy notice.`,
};

export const LEGAL_FR: LegalStrings = {
  legalTitle: 'Mentions légales',
  privacyTitle: 'Politique de confidentialité',
  backHome: 'Retour au site',
  publisher: 'Éditeur du site',
  legalName: 'Dénomination',
  legalForm: 'Forme juridique',
  registration: 'Immatriculation (SIRET/RCS)',
  vat: 'Numéro de TVA intracommunautaire',
  address: 'Adresse',
  phone: 'Téléphone',
  email: 'E-mail',
  director: 'Directeur de la publication',
  host: 'Hébergement',
  hostIntro: (host) => `Ce site est conçu et hébergé par ${host}.`,
  ip: 'Propriété intellectuelle et crédits',
  ipBody: (business) =>
    `Le contenu de ce site appartient à ${business} ou est utilisé avec autorisation. Les photographies issues de banques d’images sont créditées à l’endroit où elles apparaissent.`,
  contact: 'Contact',
  contactBody: (email) => `Pour toute question concernant ce site, écrivez à ${email}.`,
  controllerTitle: 'Responsable du traitement',
  controllerBody: (business) =>
    `${business} est responsable des données personnelles transmises par l’intermédiaire de ce site (responsable du traitement).`,
  processorTitle: 'Sous-traitant',
  processorBody: (host) =>
    `${host} héberge le site et son formulaire de contact pour le compte de l’entreprise (sous-traitant).`,
  purposeTitle: 'Finalité',
  purposeBody: 'Répondre aux messages que vous envoyez via le formulaire de contact. Rien d’autre.',
  basisTitle: 'Base légale',
  basisBody: 'Votre demande : vous écrivez à l’entreprise afin qu’elle vous réponde.',
  retentionTitle: 'Durée de conservation',
  retentionBody: 'Les messages sont conservés le temps nécessaire pour y répondre, et au maximum 24 mois.',
  rightsTitle: 'Vos droits',
  rightsBody: (email) =>
    `Vous pouvez accéder à vos données, les rectifier ou les effacer, vous opposer à leur traitement ou en demander la limitation en écrivant à ${email}. Vous pouvez également introduire une réclamation auprès de la CNIL.`,
  cookiesTitle: 'Cookies et statistiques',
  cookiesBody:
    'Ce site ne dépose aucun cookie et ne charge aucun traceur tiers. Les visites sont comptabilisées de manière anonyme, sans conservation de votre adresse IP.',
  dpo: (contact) => `Contact pour la protection des données : ${contact}.`,
  missing: 'Cette information est en cours de complétion.',
  updated: (date) => `Dernière mise à jour : ${date}.`,
  footerLegal: 'Mentions légales',
  footerPrivacy: 'Confidentialité',
  formNotice: (business) => `Votre message est envoyé à ${business}. Voir la politique de confidentialité.`,
};

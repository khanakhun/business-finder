import type { SiteLocale } from '@bf/site-schema';

/** The renderer's own pages (not found, ended preview), in the site languages. */
export interface RendererStrings {
  readonly notFoundTitle: string;
  readonly notFoundBody: string;
  readonly backHome: string;
  readonly goneTitle: string;
  readonly goneBody: (business: string, agency: string) => string;
  readonly contactAgency: (agency: string) => string;
  readonly unknownTitle: string;
  readonly unknownBody: string;
  readonly unavailableTitle: string;
  readonly unavailableBody: string;
  readonly claim: string;
  readonly optOut: string;
  readonly errorTitle: string;
  readonly errorBody: string;
}

export const RENDERER_STRINGS: Readonly<Record<SiteLocale, RendererStrings>> = {
  fr: {
    claim: 'C’est mon entreprise — ça m’intéresse',
    optOut: 'Pas intéressé — ne plus me contacter',
    unavailableTitle: 'Site momentanément indisponible',
    unavailableBody: 'Le site ne peut pas être affiché pour le moment. Réessayez dans quelques minutes.',
    notFoundTitle: 'Page introuvable',
    notFoundBody: 'Cette page n’existe pas ou a été déplacée.',
    backHome: 'Retour à l’accueil',
    goneTitle: 'Cet aperçu a expiré',
    goneBody: (business, agency) =>
      `L’aperçu du site proposé à ${business} par ${agency} n’est plus en ligne.`,
    contactAgency: (agency) => `Contacter ${agency}`,
    unknownTitle: 'Site introuvable',
    unknownBody: 'Aucun site n’est publié à cette adresse.',
    errorTitle: 'Une erreur est survenue',
    errorBody: 'La page n’a pas pu être affichée. Réessayez dans un instant.',
  },
  en: {
    claim: 'This is my business — I’m interested',
    optOut: 'Not interested — don’t contact me',
    unavailableTitle: 'Site temporarily unavailable',
    unavailableBody: 'The site cannot be shown right now. Please try again in a few minutes.',
    notFoundTitle: 'Page not found',
    notFoundBody: 'This page does not exist or has moved.',
    backHome: 'Back to the home page',
    goneTitle: 'This preview has expired',
    goneBody: (business, agency) => `The preview site ${agency} made for ${business} is no longer online.`,
    contactAgency: (agency) => `Contact ${agency}`,
    unknownTitle: 'Site not found',
    unknownBody: 'No site is published at this address.',
    errorTitle: 'Something went wrong',
    errorBody: 'The page could not be shown. Please try again in a moment.',
  },
  nl: {
    claim: 'Dit is mijn bedrijf — ik heb interesse',
    optOut: 'Geen interesse — neem geen contact op',
    unavailableTitle: 'Site tijdelijk niet beschikbaar',
    unavailableBody: 'De site kan nu niet worden getoond. Probeer het over enkele minuten opnieuw.',
    notFoundTitle: 'Pagina niet gevonden',
    notFoundBody: 'Deze pagina bestaat niet of is verplaatst.',
    backHome: 'Terug naar de startpagina',
    goneTitle: 'Deze preview is verlopen',
    goneBody: (business, agency) =>
      `De previewsite die ${agency} voor ${business} maakte, is niet meer online.`,
    contactAgency: (agency) => `Contact opnemen met ${agency}`,
    unknownTitle: 'Site niet gevonden',
    unknownBody: 'Op dit adres is geen site gepubliceerd.',
    errorTitle: 'Er ging iets mis',
    errorBody: 'De pagina kon niet worden getoond. Probeer het zo meteen opnieuw.',
  },
  es: {
    claim: 'Es mi negocio — me interesa',
    optOut: 'No me interesa — no me contacten',
    unavailableTitle: 'Sitio no disponible temporalmente',
    unavailableBody: 'El sitio no se puede mostrar en este momento. Inténtelo de nuevo en unos minutos.',
    notFoundTitle: 'Página no encontrada',
    notFoundBody: 'Esta página no existe o se ha movido.',
    backHome: 'Volver al inicio',
    goneTitle: 'Esta vista previa ha caducado',
    goneBody: (business, agency) =>
      `La vista previa que ${agency} creó para ${business} ya no está en línea.`,
    contactAgency: (agency) => `Contactar con ${agency}`,
    unknownTitle: 'Sitio no encontrado',
    unknownBody: 'No hay ningún sitio publicado en esta dirección.',
    errorTitle: 'Algo salió mal',
    errorBody: 'No se pudo mostrar la página. Inténtelo de nuevo en un momento.',
  },
  de: {
    claim: 'Das ist mein Unternehmen — ich bin interessiert',
    optOut: 'Kein Interesse — bitte nicht kontaktieren',
    unavailableTitle: 'Website vorübergehend nicht verfügbar',
    unavailableBody:
      'Die Website kann gerade nicht angezeigt werden. Bitte versuchen Sie es in ein paar Minuten erneut.',
    notFoundTitle: 'Seite nicht gefunden',
    notFoundBody: 'Diese Seite existiert nicht oder wurde verschoben.',
    backHome: 'Zur Startseite',
    goneTitle: 'Diese Vorschau ist abgelaufen',
    goneBody: (business, agency) =>
      `Die Vorschau, die ${agency} für ${business} erstellt hat, ist nicht mehr online.`,
    contactAgency: (agency) => `${agency} kontaktieren`,
    unknownTitle: 'Website nicht gefunden',
    unknownBody: 'Unter dieser Adresse ist keine Website veröffentlicht.',
    errorTitle: 'Etwas ist schiefgelaufen',
    errorBody: 'Die Seite konnte nicht angezeigt werden. Bitte versuchen Sie es gleich noch einmal.',
  },
};

/** The renderer's strings in a language (English for an unknown one). */
export const rendererStrings = (locale: string | undefined): RendererStrings =>
  RENDERER_STRINGS[(locale ?? 'en') as SiteLocale] ?? RENDERER_STRINGS.en;

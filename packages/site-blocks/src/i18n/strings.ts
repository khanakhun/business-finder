import type { SiteLocale } from '@bf/site-schema';

// The block library's own words (BF-034): labels the spec does not carry (skip link, menu, hours, form, units), in
// every site language. Content always comes from the spec; these are only the interface around it. French follows
// its typography (a narrow no-break space before `:`, `?` and `!`).

export interface UiStrings {
  readonly skipToContent: string;
  readonly menu: string;
  readonly closeMenu: string;
  readonly mainMenu: string;
  readonly languages: string;
  readonly languageNames: Readonly<Record<SiteLocale, string>>;
  readonly home: string;
  readonly previewBanner: (brand: string) => string;
  readonly previewBannerBy: (brand: string, agency: string) => string;
  readonly previewLabel: string;
  readonly openNow: string;
  readonly closedNow: string;
  readonly closesAt: (time: string) => string;
  readonly opensAt: (day: string, time: string) => string;
  readonly closed: string;
  readonly today: string;
  readonly hours: string;
  readonly contact: string;
  readonly phone: string;
  readonly email: string;
  readonly whatsapp: string;
  readonly address: string;
  readonly directions: string;
  readonly openMap: string;
  readonly mapOf: (place: string) => string;
  readonly from: (price: string) => string;
  readonly units: Readonly<Record<'each' | 'per_person' | 'per_hour' | 'per_night', string>>;
  readonly menuTags: Readonly<
    Record<'vegetarian' | 'vegan' | 'gluten_free' | 'spicy' | 'house_special' | 'local', string>
  >;
  readonly rating: (stars: number) => string;
  readonly reviewOn: (source: string) => string;
  readonly translated: string;
  readonly enlarge: (alt: string) => string;
  readonly close: string;
  readonly photos: string;
  readonly followUs: string;
  readonly profileOn: (network: string) => string;
  readonly form: {
    readonly name: string;
    readonly email: string;
    readonly phone: string;
    readonly message: string;
    readonly optional: string;
    readonly send: string;
    readonly sending: string;
    readonly sent: string;
    readonly failed: string;
    readonly required: string;
    readonly invalidEmail: string;
    readonly unavailable: string;
  };
  readonly booking: {
    readonly show: string;
    readonly notice: (host: string) => string;
    readonly openPage: string;
    readonly frameTitle: string;
  };
  readonly allRights: (brand: string) => string;
}

const NNBSP = ' ';

const fr: UiStrings = {
  skipToContent: 'Aller au contenu',
  menu: 'Menu',
  closeMenu: 'Fermer le menu',
  mainMenu: 'Menu principal',
  languages: 'Langues',
  languageNames: { fr: 'Français', en: 'English', nl: 'Nederlands', es: 'Español', de: 'Deutsch' },
  home: 'Accueil',
  previewBanner: (brand) => `Aperçu d’un concept de site — ce n’est pas le site officiel de ${brand}.`,
  previewBannerBy: (brand, agency) =>
    `Aperçu d’un concept de site proposé par ${agency} — ce n’est pas le site officiel de ${brand}.`,
  previewLabel: 'Aperçu',
  openNow: 'Ouvert',
  closedNow: 'Fermé',
  closesAt: (time) => `Ferme à ${time}`,
  opensAt: (day, time) => `Ouvre ${day} à ${time}`,
  closed: 'Fermé',
  today: 'Aujourd’hui',
  hours: 'Horaires',
  contact: 'Contact',
  phone: 'Téléphone',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
  address: 'Adresse',
  directions: 'Itinéraire',
  openMap: 'Voir sur la carte',
  mapOf: (place) => `Plan d’accès${NNBSP}: ${place}`,
  from: (price) => `à partir de ${price}`,
  units: { each: 'l’unité', per_person: 'par personne', per_hour: 'de l’heure', per_night: 'la nuit' },
  menuTags: {
    vegetarian: 'Végétarien',
    vegan: 'Végétalien',
    gluten_free: 'Sans gluten',
    spicy: 'Épicé',
    house_special: 'Spécialité maison',
    local: 'Produit local',
  },
  rating: (stars) => `${stars} sur 5 étoiles`,
  reviewOn: (source) => `Avis publié sur ${source}`,
  translated: 'Traduit',
  enlarge: (alt) => `Agrandir la photo${NNBSP}: ${alt}`,
  close: 'Fermer',
  photos: 'Photos',
  followUs: 'Suivez-nous',
  profileOn: (network) => `Notre page ${network}`,
  form: {
    name: 'Nom',
    email: 'E-mail',
    phone: 'Téléphone',
    message: 'Message',
    optional: 'facultatif',
    send: 'Envoyer',
    sending: 'Envoi…',
    sent: 'Merci, votre message a bien été envoyé.',
    failed: 'L’envoi a échoué. Réessayez ou contactez-nous directement.',
    required: 'Ce champ est obligatoire.',
    invalidEmail: 'Saisissez une adresse e-mail valide.',
    unavailable: 'Le formulaire n’est pas disponible dans cet aperçu.',
  },
  booking: {
    show: 'Afficher le calendrier de réservation',
    notice: (host) => `Le calendrier est fourni par ${host}${NNBSP}; il ne se charge que si vous l’affichez.`,
    openPage: 'Ouvrir la page de réservation',
    frameTitle: 'Réservation en ligne',
  },
  allRights: (brand) => `© ${brand}`,
};

const en: UiStrings = {
  skipToContent: 'Skip to content',
  menu: 'Menu',
  closeMenu: 'Close menu',
  mainMenu: 'Main menu',
  languages: 'Languages',
  languageNames: fr.languageNames,
  home: 'Home',
  previewBanner: (brand) => `Website concept preview — this is not the official website of ${brand}.`,
  previewBannerBy: (brand, agency) =>
    `Website concept preview by ${agency} — this is not the official website of ${brand}.`,
  previewLabel: 'Preview',
  openNow: 'Open now',
  closedNow: 'Closed now',
  closesAt: (time) => `Closes at ${time}`,
  opensAt: (day, time) => `Opens ${day} at ${time}`,
  closed: 'Closed',
  today: 'Today',
  hours: 'Opening hours',
  contact: 'Contact',
  phone: 'Phone',
  email: 'Email',
  whatsapp: 'WhatsApp',
  address: 'Address',
  directions: 'Directions',
  openMap: 'View on the map',
  mapOf: (place) => `Map: ${place}`,
  from: (price) => `from ${price}`,
  units: { each: 'each', per_person: 'per person', per_hour: 'per hour', per_night: 'per night' },
  menuTags: {
    vegetarian: 'Vegetarian',
    vegan: 'Vegan',
    gluten_free: 'Gluten-free',
    spicy: 'Spicy',
    house_special: 'House special',
    local: 'Local produce',
  },
  rating: (stars) => `${stars} out of 5 stars`,
  reviewOn: (source) => `Review published on ${source}`,
  translated: 'Translated',
  enlarge: (alt) => `Enlarge photo: ${alt}`,
  close: 'Close',
  photos: 'Photos',
  followUs: 'Follow us',
  profileOn: (network) => `Our ${network} page`,
  form: {
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    message: 'Message',
    optional: 'optional',
    send: 'Send',
    sending: 'Sending…',
    sent: 'Thank you, your message has been sent.',
    failed: 'Sending failed. Please try again or contact us directly.',
    required: 'This field is required.',
    invalidEmail: 'Enter a valid email address.',
    unavailable: 'The form is not available in this preview.',
  },
  booking: {
    show: 'Show the booking calendar',
    notice: (host) => `The calendar is provided by ${host}; it loads only if you show it.`,
    openPage: 'Open the booking page',
    frameTitle: 'Online booking',
  },
  allRights: (brand) => `© ${brand}`,
};

const nl: UiStrings = {
  ...en,
  skipToContent: 'Naar de inhoud',
  menu: 'Menu',
  closeMenu: 'Menu sluiten',
  mainMenu: 'Hoofdmenu',
  languages: 'Talen',
  home: 'Home',
  previewBanner: (brand) =>
    `Voorbeeld van een websiteconcept — dit is niet de officiële website van ${brand}.`,
  previewBannerBy: (brand, agency) =>
    `Voorbeeld van een websiteconcept door ${agency} — dit is niet de officiële website van ${brand}.`,
  previewLabel: 'Voorbeeld',
  openNow: 'Nu open',
  closedNow: 'Nu gesloten',
  closesAt: (time) => `Sluit om ${time}`,
  opensAt: (day, time) => `Opent ${day} om ${time}`,
  closed: 'Gesloten',
  today: 'Vandaag',
  hours: 'Openingstijden',
  phone: 'Telefoon',
  email: 'E-mail',
  address: 'Adres',
  directions: 'Route',
  openMap: 'Bekijk op de kaart',
  mapOf: (place) => `Kaart: ${place}`,
  from: (price) => `vanaf ${price}`,
  units: { each: 'per stuk', per_person: 'per persoon', per_hour: 'per uur', per_night: 'per nacht' },
  menuTags: {
    vegetarian: 'Vegetarisch',
    vegan: 'Veganistisch',
    gluten_free: 'Glutenvrij',
    spicy: 'Pittig',
    house_special: 'Huisspecialiteit',
    local: 'Lokaal product',
  },
  rating: (stars) => `${stars} van 5 sterren`,
  reviewOn: (source) => `Recensie op ${source}`,
  translated: 'Vertaald',
  enlarge: (alt) => `Foto vergroten: ${alt}`,
  close: 'Sluiten',
  photos: "Foto's",
  followUs: 'Volg ons',
  profileOn: (network) => `Onze ${network}-pagina`,
  form: {
    name: 'Naam',
    email: 'E-mail',
    phone: 'Telefoon',
    message: 'Bericht',
    optional: 'optioneel',
    send: 'Versturen',
    sending: 'Versturen…',
    sent: 'Bedankt, uw bericht is verstuurd.',
    failed: 'Versturen mislukt. Probeer het opnieuw of neem rechtstreeks contact op.',
    required: 'Dit veld is verplicht.',
    invalidEmail: 'Vul een geldig e-mailadres in.',
    unavailable: 'Het formulier is niet beschikbaar in dit voorbeeld.',
  },
  booking: {
    show: 'Toon de reserveringskalender',
    notice: (host) => `De kalender wordt geleverd door ${host}; hij laadt alleen als u hem toont.`,
    openPage: 'Open de reserveringspagina',
    frameTitle: 'Online reserveren',
  },
};

const es: UiStrings = {
  ...en,
  skipToContent: 'Ir al contenido',
  menu: 'Menú',
  closeMenu: 'Cerrar el menú',
  mainMenu: 'Menú principal',
  languages: 'Idiomas',
  home: 'Inicio',
  previewBanner: (brand) => `Vista previa de un concepto de web — no es la web oficial de ${brand}.`,
  previewBannerBy: (brand, agency) =>
    `Vista previa de un concepto de web de ${agency} — no es la web oficial de ${brand}.`,
  previewLabel: 'Vista previa',
  openNow: 'Abierto ahora',
  closedNow: 'Cerrado ahora',
  closesAt: (time) => `Cierra a las ${time}`,
  opensAt: (day, time) => `Abre el ${day} a las ${time}`,
  closed: 'Cerrado',
  today: 'Hoy',
  hours: 'Horario',
  contact: 'Contacto',
  phone: 'Teléfono',
  email: 'Correo',
  address: 'Dirección',
  directions: 'Cómo llegar',
  openMap: 'Ver en el mapa',
  mapOf: (place) => `Mapa: ${place}`,
  from: (price) => `desde ${price}`,
  units: { each: 'la unidad', per_person: 'por persona', per_hour: 'por hora', per_night: 'por noche' },
  menuTags: {
    vegetarian: 'Vegetariano',
    vegan: 'Vegano',
    gluten_free: 'Sin gluten',
    spicy: 'Picante',
    house_special: 'Especialidad de la casa',
    local: 'Producto local',
  },
  rating: (stars) => `${stars} de 5 estrellas`,
  reviewOn: (source) => `Opinión publicada en ${source}`,
  translated: 'Traducido',
  enlarge: (alt) => `Ampliar la foto: ${alt}`,
  close: 'Cerrar',
  photos: 'Fotos',
  followUs: 'Síguenos',
  profileOn: (network) => `Nuestra página de ${network}`,
  form: {
    name: 'Nombre',
    email: 'Correo',
    phone: 'Teléfono',
    message: 'Mensaje',
    optional: 'opcional',
    send: 'Enviar',
    sending: 'Enviando…',
    sent: 'Gracias, su mensaje ha sido enviado.',
    failed: 'El envío ha fallado. Vuelva a intentarlo o contáctenos directamente.',
    required: 'Este campo es obligatorio.',
    invalidEmail: 'Introduzca un correo válido.',
    unavailable: 'El formulario no está disponible en esta vista previa.',
  },
  booking: {
    show: 'Mostrar el calendario de reservas',
    notice: (host) => `El calendario lo proporciona ${host}; solo se carga si lo muestra.`,
    openPage: 'Abrir la página de reservas',
    frameTitle: 'Reserva en línea',
  },
};

const de: UiStrings = {
  ...en,
  skipToContent: 'Zum Inhalt',
  menu: 'Menü',
  closeMenu: 'Menü schließen',
  mainMenu: 'Hauptmenü',
  languages: 'Sprachen',
  home: 'Start',
  previewBanner: (brand) =>
    `Vorschau eines Website-Konzepts — dies ist nicht die offizielle Website von ${brand}.`,
  previewBannerBy: (brand, agency) =>
    `Vorschau eines Website-Konzepts von ${agency} — dies ist nicht die offizielle Website von ${brand}.`,
  previewLabel: 'Vorschau',
  openNow: 'Jetzt geöffnet',
  closedNow: 'Jetzt geschlossen',
  closesAt: (time) => `Schließt um ${time}`,
  opensAt: (day, time) => `Öffnet ${day} um ${time}`,
  closed: 'Geschlossen',
  today: 'Heute',
  hours: 'Öffnungszeiten',
  contact: 'Kontakt',
  phone: 'Telefon',
  email: 'E-Mail',
  address: 'Adresse',
  directions: 'Route',
  openMap: 'Auf der Karte ansehen',
  mapOf: (place) => `Karte: ${place}`,
  from: (price) => `ab ${price}`,
  units: { each: 'pro Stück', per_person: 'pro Person', per_hour: 'pro Stunde', per_night: 'pro Nacht' },
  menuTags: {
    vegetarian: 'Vegetarisch',
    vegan: 'Vegan',
    gluten_free: 'Glutenfrei',
    spicy: 'Scharf',
    house_special: 'Spezialität des Hauses',
    local: 'Regionales Produkt',
  },
  rating: (stars) => `${stars} von 5 Sternen`,
  reviewOn: (source) => `Bewertung auf ${source}`,
  translated: 'Übersetzt',
  enlarge: (alt) => `Foto vergrößern: ${alt}`,
  close: 'Schließen',
  photos: 'Fotos',
  followUs: 'Folgen Sie uns',
  profileOn: (network) => `Unsere ${network}-Seite`,
  form: {
    name: 'Name',
    email: 'E-Mail',
    phone: 'Telefon',
    message: 'Nachricht',
    optional: 'optional',
    send: 'Senden',
    sending: 'Wird gesendet…',
    sent: 'Danke, Ihre Nachricht wurde gesendet.',
    failed: 'Senden fehlgeschlagen. Bitte erneut versuchen oder uns direkt kontaktieren.',
    required: 'Dieses Feld ist erforderlich.',
    invalidEmail: 'Geben Sie eine gültige E-Mail-Adresse ein.',
    unavailable: 'Das Formular ist in dieser Vorschau nicht verfügbar.',
  },
  booking: {
    show: 'Buchungskalender anzeigen',
    notice: (host) => `Der Kalender wird von ${host} bereitgestellt; er lädt nur, wenn Sie ihn anzeigen.`,
    openPage: 'Buchungsseite öffnen',
    frameTitle: 'Online buchen',
  },
};

export const UI_STRINGS: Readonly<Record<SiteLocale, UiStrings>> = { fr, en, nl, es, de };

export const uiStrings = (locale: SiteLocale): UiStrings => UI_STRINGS[locale];

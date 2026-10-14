import type { AppLocale } from './i18n/locales.ts';
import type messages from './i18n/messages/en.json';

// Typed message keys and locales for next-intl: a missing or misspelled key fails `tsc`.
declare module 'next-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof messages;
  }
}

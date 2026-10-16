import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, negotiateLocale } from './locales.ts';

export default getRequestConfig(async () => {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookie)
    ? cookie
    : (negotiateLocale((await headers()).get('accept-language')) ?? DEFAULT_LOCALE);
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default,
    timeZone: 'America/St_Barthelemy',
  };
});

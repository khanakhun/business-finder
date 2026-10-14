'use server';

import { cookies } from 'next/headers';
import { isLocale, LOCALE_COOKIE } from './locales.ts';

/** Persists the dashboard language for a year. The caller refreshes the router to re-render with it. */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: '/', maxAge: 365 * 24 * 3600, sameSite: 'lax' });
}

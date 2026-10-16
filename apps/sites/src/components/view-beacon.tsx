'use client';

import { useEffect } from 'react';

const CAMPAIGN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The view beacon (BF-035 endpoint): one anonymous request when the page shows, with the site's signed token, the
 * page, its language and the campaign of the link that brought the visitor (`?c=`). No cookie, no storage; nothing
 * is sent when the browser says Do Not Track or Global Privacy Control. A `text/plain` body keeps it a simple
 * request (no preflight; the response is never read), sent without credentials.
 */
export function ViewBeacon({
  endpoint,
  token,
  pageId,
  locale,
}: {
  endpoint: string;
  token: string;
  pageId: string;
  locale: string;
}) {
  useEffect(() => {
    const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (privacy.doNotTrack === '1' || privacy.globalPrivacyControl === true) return;
    const campaign = new URLSearchParams(window.location.search).get('c');
    const body = JSON.stringify({
      token,
      pageId,
      locale,
      ...(campaign && CAMPAIGN.test(campaign) ? { c: campaign } : {}),
    });
    // No credentials, ever (sendBeacon would send cookies); kept alive past navigation like a beacon.
    void fetch(endpoint, {
      method: 'POST',
      body,
      keepalive: true,
      credentials: 'omit',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
    }).catch(() => undefined);
  }, [endpoint, token, pageId, locale]);
  return null;
}

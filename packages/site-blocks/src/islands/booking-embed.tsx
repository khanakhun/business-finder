'use client';

import { useState } from 'react';
import type { UiStrings } from '../i18n/strings.ts';

/**
 * The booking provider's page in a frame (an island), loaded only when the visitor asks for it: until then no
 * request reaches the provider. The frame is sandboxed; the provider is named before it loads.
 */
export function BookingEmbed({
  src,
  host,
  label,
  strings,
}: {
  src: string;
  host: string;
  label: string;
  strings: UiStrings['booking'];
}) {
  const [shown, setShown] = useState(false);
  if (shown) {
    return (
      <iframe
        src={src}
        title={strings.frameTitle}
        className="h-[44rem] w-full max-w-4xl rounded-card border border-[var(--bf-line)] bg-white"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    );
  }
  return (
    <div className="bf-card flex w-full max-w-2xl flex-col items-center gap-5 !h-auto">
      <p className="bf-muted text-sm">{strings.notice(host)}</p>
      <div className="bf-actions justify-center">
        <button type="button" className="bf-btn bf-btn-primary" onClick={() => setShown(true)}>
          {strings.show}
        </button>
        <a href={src} className="bf-btn bf-btn-secondary">
          {label}
        </a>
      </div>
    </div>
  );
}

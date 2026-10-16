'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The booking provider's page in a frame (an island), loaded only when the visitor asks for it: until then no
 * request reaches the provider. The frame is sandboxed; the provider is named before it loads.
 */
export function BookingEmbed({
  src,
  label,
  notice,
  show,
  frameTitle,
}: {
  src: string;
  /** The page's own button label (opens the provider's page). */
  label: string;
  /** Names the provider before anything loads. */
  notice: string;
  show: string;
  frameTitle: string;
}) {
  const [shown, setShown] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // The visitor asked for the calendar: focus moves to it (the button they pressed is gone).
  useEffect(() => {
    if (shown) frame.current?.focus();
  }, [shown]);
  if (shown) {
    return (
      <iframe
        ref={frame}
        src={src}
        title={frameTitle}
        className="h-[44rem] w-full max-w-4xl rounded-card border border-[var(--bf-line)] bg-white"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
      />
    );
  }
  return (
    <div className="bf-card flex w-full max-w-2xl flex-col items-center gap-5 !h-auto">
      <p className="bf-muted text-sm">{notice}</p>
      <div className="bf-actions justify-center">
        <button type="button" className="bf-btn bf-btn-primary" onClick={() => setShown(true)}>
          {show}
        </button>
        <a href={src} className="bf-btn bf-btn-secondary">
          {label}
        </a>
      </div>
    </div>
  );
}

'use client';

import { Button } from '@bf/ui/components/button';
import { ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

// A reply's HTML (BF-054): sanitized server-side, then rendered in a sandboxed frame (no scripts, no same origin) with
// a strict CSP. Remote images stay off until the person asks for them, per message ("show images").

const CSP_OFF = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const CSP_ON = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:";

const document = (html: string, images: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${
    images ? CSP_ON : CSP_OFF
  }"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#111;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${
    images ? html.replace(/\sdata-remote-src=/g, ' src=') : html
  }</body></html>`;

export function MessageFrame({
  html,
  text,
  hasRemoteImages,
}: {
  readonly html: string | null;
  readonly text: string;
  readonly hasRemoteImages: boolean;
}) {
  const t = useTranslations('inbox.message');
  const [images, setImages] = React.useState(false);
  if (!html)
    return <pre className="whitespace-pre-wrap rounded-md border bg-background p-3 text-sm">{text}</pre>;
  return (
    <div className="space-y-2">
      {hasRemoteImages && !images ? (
        <Button size="sm" variant="outline" onClick={() => setImages(true)}>
          <ImageIcon aria-hidden />
          {t('showImages')}
        </Button>
      ) : null}
      <iframe
        title={t('frame')}
        // Links open in a new tab (target=_blank set by the sanitizer); nothing else is allowed.
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="h-96 w-full rounded-md border bg-white"
        srcDoc={document(html, images)}
      />
    </div>
  );
}

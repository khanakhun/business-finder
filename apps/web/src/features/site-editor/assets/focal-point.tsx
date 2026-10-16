'use client';

import { useTranslations } from 'next-intl';
import type * as React from 'react';

export interface FocalPoint {
  readonly x: number;
  readonly y: number;
}

const STEP = 0.05;

/** The picture's address, only as an object URL (a local file) or a web address (our CDN): never markup. */
function imageSource(src: string): string | undefined {
  try {
    const url = new URL(src);
    return ['blob:', 'https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
const clamp = (value: number) => Math.min(1, Math.max(0, Math.round(value * 100) / 100));

/**
 * Picks the point of an image to keep in view when a layout crops it: a click on the image, or the arrow keys
 * (5 % a press) for keyboard users.
 */
export function FocalPointPicker({
  src,
  alt,
  value,
  onChange,
}: {
  readonly src: string;
  readonly alt: string;
  readonly value: FocalPoint;
  readonly onChange: (point: FocalPoint) => void;
}) {
  const t = useTranslations('siteEditor.assets');
  const onKey = (event: React.KeyboardEvent) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    onChange({ x: clamp(value.x + move[0]), y: clamp(value.y + move[1]) });
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{t('focalPoint')}</span>
      {/* A slider in two dimensions: the role says how to use it, the value where the point is. */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={t('focalPoint')}
        aria-valuetext={t('focalPointValue', { x: Math.round(value.x * 100), y: Math.round(value.y * 100) })}
        aria-valuenow={Math.round(value.x * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="focus-visible:ring-ring relative max-w-xs cursor-crosshair overflow-hidden rounded-md outline-none focus-visible:ring-2"
        onKeyDown={onKey}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          onChange({
            x: clamp((event.clientX - box.left) / box.width),
            y: clamp((event.clientY - box.top) / box.height),
          });
        }}
      >
        <img src={imageSource(src)} alt={alt} className="block h-auto w-full" draggable={false} />
        <span
          aria-hidden
          className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_2px_rgba(0,0,0,0.6)]"
          style={{ left: `${value.x * 100}%`, top: `${value.y * 100}%` }}
        />
      </div>
      <span className="text-muted-foreground text-xs">{t('focalPointHelp')}</span>
    </div>
  );
}

'use client';

import * as React from 'react';
import { cn } from '../lib/utils.ts';

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Display form of a shortcut: `mod` becomes ⌘ on Apple devices and Ctrl elsewhere. */
export function formatShortcut(keys: readonly string[], apple: boolean): string[] {
  return keys.map((key) => {
    if (key === 'mod') return apple ? '⌘' : 'Ctrl';
    if (key === 'shift') return apple ? '⇧' : 'Shift';
    if (key === 'alt') return apple ? '⌥' : 'Alt';
    return key.length === 1 ? key.toUpperCase() : key;
  });
}

export interface KeyboardShortcutProps {
  /** Keys in order, e.g. `['mod', 'k']` or `['?']`. */
  readonly keys: readonly string[];
  readonly className?: string;
}

export function KeyboardShortcut({ keys, className }: KeyboardShortcutProps) {
  // Render the non-Apple form on the server, then correct after hydration (no mismatch warning).
  const [apple, setApple] = React.useState(false);
  React.useEffect(() => setApple(isApple()), []);
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {formatShortcut(keys, apple).map((key) => (
        <kbd
          key={key}
          className="min-w-5 rounded border border-line-strong bg-surface px-1 text-center text-xs text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

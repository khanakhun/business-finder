'use client';

import { Input } from '@bf/ui/components/input';
import * as React from 'react';

/** A number as typed ("", "-", "0,5" are fine while typing); null until it parses. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * A number field that keeps what is typed (an empty field, a lone "-", a decimal comma) and commits each value that
 * parses; it follows the value when it changes from outside (a reset, a slider).
 */
export function NumericInput({
  value,
  onCommit,
  integer = false,
  min,
  max,
  ...props
}: Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'type'> & {
  readonly value: number;
  readonly onCommit: (value: number) => void;
  readonly integer?: boolean;
  /** Bounds: a typed value outside them is committed clamped (the field shows the clamped value). */
  readonly min?: number;
  readonly max?: number;
}) {
  const [text, setText] = React.useState(String(value));
  const parsed = parseNumber(text);
  // Follow outside changes (not the echo of what was just typed).
  React.useEffect(() => {
    setText((current) => (parseNumber(current) === value ? current : String(value)));
  }, [value]);
  const invalid = parsed === null || (integer && !Number.isInteger(parsed));
  return (
    <Input
      {...props}
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      value={text}
      aria-invalid={invalid || props['aria-invalid']}
      onChange={(event) => {
        setText(event.target.value);
        const next = parseNumber(event.target.value);
        if (next !== null && (!integer || Number.isInteger(next))) {
          onCommit(
            Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, next)),
          );
        }
      }}
      // Leaving the field shows what the draft holds when the text says otherwise (a value already at its bound, an
      // unfinished or refused one); a typed "0,5" stays as typed.
      onBlur={(event) => {
        setText((current) => (parseNumber(current) === value ? current : String(value)));
        props.onBlur?.(event);
      }}
    />
  );
}

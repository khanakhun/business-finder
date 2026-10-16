'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import * as React from 'react';

export interface VirtualRows {
  readonly enabled: boolean;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  /** Row indexes to render. */
  indexes(count: number): number[];
  /** Brings a row into view (no-op when not virtualised: the row element scrolls itself). */
  scrollToIndex(index: number): void;
}

/** Renders only the visible rows of long tables, padding the rest so the scrollbar stays honest. */
export function useVirtualRows(options: {
  count: number;
  scrollRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  estimateRowHeight?: number;
}): VirtualRows {
  const virtualizer = useVirtualizer({
    count: options.enabled ? options.count : 0,
    getScrollElement: () => options.scrollRef.current,
    estimateSize: () => options.estimateRowHeight ?? 41,
    overscan: 12,
  });
  const { enabled, scrollRef } = options;
  const scrollToIndex = React.useCallback(
    (index: number) => {
      if (enabled) {
        virtualizer.scrollToIndex(index, { align: 'auto' });
        return;
      }
      const rows = scrollRef.current?.querySelectorAll('tbody > tr:not([aria-hidden])');
      rows?.[index]?.scrollIntoView?.({ block: 'nearest' });
    },
    [enabled, scrollRef, virtualizer],
  );
  if (!options.enabled) {
    return {
      enabled: false,
      paddingTop: 0,
      paddingBottom: 0,
      indexes: (count) => Array.from({ length: count }, (_, i) => i),
      scrollToIndex,
    };
  }
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items[items.length - 1];
  return {
    enabled: true,
    paddingTop: first ? first.start : 0,
    paddingBottom: last ? virtualizer.getTotalSize() - last.end : 0,
    indexes: () => items.map((item) => item.index),
    scrollToIndex,
  };
}

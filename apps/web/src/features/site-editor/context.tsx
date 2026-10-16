'use client';

import type { SiteLocale, SiteSpec } from '@bf/site-schema';
import * as React from 'react';

/**
 * What the canvas and the fields read besides an item's own props (BF-037): the site as edited so far (its pages,
 * images, theme and languages), the page shown, the language being written and whether this person may edit. Puck's
 * config stays the same while these change; its renders and fields read them here.
 */
export interface SiteEditorState {
  readonly spec: SiteSpec;
  readonly pageId: string;
  readonly locale: SiteLocale;
  readonly readOnly: boolean;
}

const SiteEditorContext = React.createContext<SiteEditorState | null>(null);

export function SiteEditorProvider({
  value,
  children,
}: {
  readonly value: SiteEditorState;
  readonly children: React.ReactNode;
}) {
  return <SiteEditorContext.Provider value={value}>{children}</SiteEditorContext.Provider>;
}

export function useSiteEditor(): SiteEditorState {
  const state = React.useContext(SiteEditorContext);
  if (!state) throw new Error('useSiteEditor needs a SiteEditorProvider.');
  return state;
}

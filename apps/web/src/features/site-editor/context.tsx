'use client';

import type { Issue, Operation, SiteLocale, SiteSpec } from '@bf/site-schema';
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

/** What the editor's panels can do (site settings, pages, issues), beside the canvas. */
export interface SiteEditorActions {
  /**
   * Applies a site-level change (settings, menu, languages, pages), then opens `open` if given; refusals are
   * reported, nothing changes then.
   */
  readonly change: (op: Operation, options?: { readonly open?: string }) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly openPage: (pageId: string) => void;
  /**
   * Registers a field's flush (its pending, debounced value): the editor flushes every field before a change or a
   * save, so nothing typed is lost. Returns the unregistration.
   */
  readonly register: (flush: () => void) => () => void;
  /** Shows and edits the site in another of its languages. */
  readonly setLocale: (locale: SiteLocale) => void;
  /** Validation issues of the site as edited (from the worker), and the way to their field. */
  readonly issues: readonly Issue[];
  /** The site the issues' paths point into: as the canvas shows it (the page on screen as edited). */
  readonly issuesSite: SiteSpec;
  readonly showIssue: (issue: Issue) => void;
}

const SiteEditorActionsContext = React.createContext<SiteEditorActions | null>(null);

export function SiteEditorActionsProvider({
  value,
  children,
}: {
  readonly value: SiteEditorActions;
  readonly children: React.ReactNode;
}) {
  return <SiteEditorActionsContext.Provider value={value}>{children}</SiteEditorActionsContext.Provider>;
}

export function useSiteEditorActions(): SiteEditorActions {
  const actions = React.useContext(SiteEditorActionsContext);
  if (!actions) throw new Error('useSiteEditorActions needs a SiteEditorActionsProvider.');
  return actions;
}

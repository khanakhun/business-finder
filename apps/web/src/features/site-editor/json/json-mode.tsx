'use client';

import { type Issue, parseSite, type SiteSpec, validateSite } from '@bf/site-schema';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { linter, lintGutter } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useTranslations } from 'next-intl';
import * as React from 'react';

// The admins' JSON mode (BF-037, `sites:admin`): the whole SiteSpec as text, for the cases the visual editor cannot
// reach. Checked as typed (JSON syntax in the editor's gutter; the schema and the validators below it); saved as one
// version with the full spec (BF-035 CreateSiteVersion), never as operations.

type Checked =
  | { readonly state: 'syntax' }
  | { readonly state: 'invalid'; readonly issues: readonly Issue[] }
  | { readonly state: 'valid'; readonly spec: SiteSpec; readonly issues: readonly Issue[] };

/** The text as a site: unreadable JSON, a document the schema refuses, or a site with its validators' issues. */
export function checkJson(text: string, assetHosts: readonly string[]): Checked {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { state: 'syntax' };
  }
  const parsed = parseSite(input);
  if (!parsed.spec) return { state: 'invalid', issues: parsed.issues };
  return {
    state: 'valid',
    spec: parsed.spec,
    issues: validateSite(parsed.spec, { assetHosts: [...assetHosts], mode: 'published' }),
  };
}

export function JsonMode({
  open,
  onOpenChange,
  spec,
  assetHosts,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The site as edited so far (unsaved changes included). */
  readonly spec: SiteSpec;
  readonly assetHosts: readonly string[];
  /** Saves the document as a new version; resolves once saved (the dialog then closes). */
  readonly onSave: (spec: SiteSpec) => Promise<boolean>;
}) {
  const t = useTranslations('siteEditor.json');
  const host = React.useRef<HTMLDivElement | null>(null);
  const view = React.useRef<EditorView | null>(null);
  const initial = React.useMemo(() => JSON.stringify(spec, null, 2), [spec]);
  const [text, setText] = React.useState(initial);
  const [checked, setChecked] = React.useState<Checked>(() => checkJson(initial, assetHosts));
  const [saving, setSaving] = React.useState(false);

  // The editor is created when the dialog's content mounts (a callback ref: Radix mounts it in a portal).
  const attach = React.useCallback(
    (element: HTMLDivElement | null) => {
      view.current?.destroy();
      view.current = null;
      host.current = element;
      if (!element) return;
      setText(initial);
      view.current = new EditorView({
        parent: element,
        state: EditorState.create({
          doc: initial,
          extensions: [
            lineNumbers(),
            history(),
            bracketMatching(),
            syntaxHighlighting(defaultHighlightStyle),
            json(),
            linter(jsonParseLinter()),
            lintGutter(),
            // Tab is left to the browser (moving focus out of the editor), so no keyboard trap.
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.contentAttributes.of({ 'aria-label': t('editorLabel') }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) setText(update.state.doc.toString());
            }),
            EditorView.theme({
              '&': { height: '100%', fontSize: '12px' },
              '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
            }),
          ],
        }),
      });
    },
    [initial, t],
  );
  React.useEffect(() => () => view.current?.destroy(), []);

  // Checked a moment after typing stops (the validators read the whole site).
  React.useEffect(() => {
    const timer = setTimeout(() => setChecked(checkJson(text, assetHosts)), 400);
    return () => clearTimeout(timer);
  }, [text, assetHosts]);

  const issues = checked.state === 'syntax' ? [] : checked.issues;
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const unchanged = text === initial;

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex h-[90dvh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <div ref={attach} className="min-h-0 flex-1 overflow-hidden rounded-md border" />
        <div className="max-h-40 overflow-y-auto text-sm" aria-live="polite">
          {checked.state === 'syntax' ? (
            <p className="text-destructive">{t('syntax')}</p>
          ) : issues.length === 0 ? (
            <p className="text-muted-foreground">{t('valid')}</p>
          ) : (
            <>
              <p className={checked.state === 'invalid' ? 'text-destructive' : 'text-muted-foreground'}>
                {checked.state === 'invalid'
                  ? t('invalid', { count: issues.length })
                  : t('issues', { errors, warnings: issues.length - errors })}
              </p>
              <ul className="list-disc pl-5">
                {issues.slice(0, 50).map((issue, index) => (
                  <li key={`${issue.code}:${issue.path.join('.')}:${index}`}>
                    <code className="text-xs">{issue.path.join('.') || '/'}</code> — {issue.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <DialogFooter>
          <span className="text-muted-foreground mr-auto self-center text-xs">{t('saveHelp')}</span>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={saving || unchanged || checked.state !== 'valid'}
            onClick={async () => {
              if (checked.state !== 'valid') return;
              setSaving(true);
              try {
                if (await onSave(checked.spec)) onOpenChange(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

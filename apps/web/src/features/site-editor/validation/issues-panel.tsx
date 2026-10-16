'use client';

import type { Issue } from '@bf/site-schema';
import { Badge } from '@bf/ui/components/badge';
import { useGetPuck } from '@puckeditor/core';
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSiteEditor, useSiteEditorActions } from '../context.tsx';
import { useConfigLabels } from '../labels.ts';

// What the validators find in the site as edited (BF-037): grouped by page and section; a click selects the section
// and its field. Errors block publishing; warnings do not.

/** Puck's zone of a page's top-level items. */
const ROOT_ZONE = 'root:default-zone';

interface Group {
  readonly key: string;
  readonly title: string;
  readonly issues: readonly Issue[];
}

export function IssuesPanel() {
  const t = useTranslations('siteEditor.issues');
  const labels = useConfigLabels();
  const { pageId } = useSiteEditor();
  const { issues, issuesSite: spec, showIssue } = useSiteEditorActions();
  const getPuck = useGetPuck();
  /** Selects the issue's section on the canvas and focuses its field (another page is opened first). */
  const select = (issue: Issue) => {
    const [root, pageIndex, kind, blockIndex, , key] = issue.path;
    const page = root === 'pages' && typeof pageIndex === 'number' ? spec.pages[pageIndex] : undefined;
    if (!page || page.id !== pageId || kind !== 'blocks' || typeof blockIndex !== 'number') {
      showIssue(issue);
      return;
    }
    getPuck().dispatch({ type: 'setUi', ui: { itemSelector: { index: blockIndex, zone: ROOT_ZONE } } });
    if (typeof key !== 'string') return;
    const label = labels.field(key);
    // Once the section's fields are shown: the first visible input of that field.
    setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>(`[aria-label^="${CSS.escape(label)}"]`)].find(
        (element) => element.offsetParent !== null,
      );
      target?.focus();
    }, 50);
  };
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const groups = new Map<string, Group>();
  for (const issue of issues) {
    const [root, pageIndex, kind, blockIndex] = issue.path;
    let key = 'site';
    let title = t('site');
    if (root === 'pages' && typeof pageIndex === 'number') {
      const page = spec.pages[pageIndex];
      const pageName = page?.title[spec.defaultLocale] ?? String(pageIndex);
      key = `page:${pageIndex}`;
      title = pageName;
      if (kind === 'blocks' && typeof blockIndex === 'number') {
        const block = page?.blocks[blockIndex];
        key = `block:${pageIndex}:${blockIndex}`;
        title = `${pageName} › ${block ? labels.block(block.type) : blockIndex}`;
      }
    }
    const group = groups.get(key) ?? { key, title, issues: [] };
    groups.set(key, { ...group, issues: [...group.issues, issue] });
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="text-sm" aria-live="polite">
        {issues.length === 0 ? t('none') : t('summary', { errors, warnings: issues.length - errors })}
      </p>
      {errors > 0 ? <p className="text-muted-foreground text-xs">{t('blocksPublishing')}</p> : null}
      {[...groups.values()].map((group) => (
        <section key={group.key} aria-label={group.title} className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold">{group.title}</h3>
          <ul className="flex flex-col gap-1">
            {group.issues.map((issue, index) => (
              <li key={`${issue.path.join('.')}:${issue.code}:${index}`}>
                <button
                  type="button"
                  className="hover:bg-muted flex w-full items-start gap-2 rounded-md p-1 text-left text-xs"
                  onClick={() => select(issue)}
                >
                  {issue.severity === 'error' ? (
                    <CircleAlertIcon aria-hidden className="text-destructive mt-0.5 size-3 shrink-0" />
                  ) : (
                    <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-amber-600" />
                  )}
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1">
                      <Badge variant={issue.severity === 'error' ? 'destructive' : 'secondary'}>
                        {t(issue.severity === 'error' ? 'error' : 'warning')}
                      </Badge>
                      {t.has(`codes.${issue.code}` as never) ? t(`codes.${issue.code}` as never) : issue.code}
                    </span>
                    {/* The validator's own sentence (it names the field and the fix). */}
                    <span className="text-muted-foreground" lang="en">
                      {issue.message}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

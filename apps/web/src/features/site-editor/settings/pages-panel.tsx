'use client';

import { Button } from '@bf/ui/components/button';
import { ArrowDownIcon, ArrowUpIcon, FileTextIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { PAGE_TEMPLATES, type PageTemplate, pageFromTemplate } from '../adapters/page-templates.ts';
import { useSiteEditor, useSiteEditorActions } from '../context.tsx';

// The site's pages (BF-037): open one on the canvas, add one from a template, reorder, delete (with a confirmation;
// the home page stays). Each change is a BF-033 operation; renaming and the address are the page's own fields.

export function PagesPanel() {
  const t = useTranslations('siteEditor.pages');
  const placeholder = useTranslations('siteEditor')('newText');
  const { spec, pageId, readOnly } = useSiteEditor();
  const { change, openPage } = useSiteEditorActions();
  const name = (id: string) => {
    const page = spec.pages.find((candidate) => candidate.id === id);
    return page?.title[spec.defaultLocale] ?? id;
  };
  const move = (from: number, to: number) => {
    const order = spec.pages.map((page) => page.id);
    const [moved] = order.splice(from, 1);
    if (moved) order.splice(to, 0, moved);
    change({ op: 'reorderPages', order });
  };
  // Built when the site changes, not on every keystroke (each template validates a candidate page).
  const templates = React.useMemo(
    () =>
      PAGE_TEMPLATES.map((template) => ({
        template,
        page: pageFromTemplate(template, spec, {
          spec,
          placeholder: () => placeholder,
          title: t(`templates.${template}` as never),
        }),
      })).filter((entry) => entry.page !== undefined),
    [spec, placeholder, t],
  );
  const add = (template: PageTemplate) => {
    const page = templates.find((entry) => entry.template === template)?.page;
    if (!page) return;
    const items =
      spec.navigation.items.length < 7
        ? [...spec.navigation.items, { pageId: page.id, label: { ...page.title } }]
        : spec.navigation.items;
    change({ op: 'addPage', page, navigation: { items } }, { open: page.id });
  };
  return (
    <div className="flex flex-col gap-3 p-4">
      <ol className="flex flex-col gap-1" aria-label={t('title')}>
        {spec.pages.map((page, index) => (
          <li
            key={page.id}
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm"
            aria-current={page.id === pageId ? 'page' : undefined}
          >
            <button
              type="button"
              className="flex flex-1 items-center gap-2 truncate text-left"
              onClick={() => openPage(page.id)}
            >
              <FileTextIcon aria-hidden className="size-4" />
              <span className={page.id === pageId ? 'font-semibold' : undefined}>{name(page.id)}</span>
              <span className="text-muted-foreground text-xs">/{page.slug}</span>
            </button>
            {readOnly ? null : (
              <>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('moveUp', { name: name(page.id) })}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUpIcon aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('moveDown', { name: name(page.id) })}
                  disabled={index === spec.pages.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDownIcon aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={t('delete', { name: name(page.id) })}
                  disabled={page.slug === ''}
                  onClick={() => {
                    if (window.confirm(t('deleteConfirm', { name: name(page.id) })))
                      change({ op: 'removePage', pageId: page.id });
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </>
            )}
          </li>
        ))}
      </ol>
      {readOnly || spec.pages.length >= 8 || templates.length === 0 ? (
        spec.pages.length >= 8 ? (
          <p className="text-muted-foreground text-xs">{t('full')}</p>
        ) : null
      ) : (
        <select
          aria-label={t('add')}
          className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
          value=""
          onChange={(event) => {
            if (event.target.value) add(event.target.value as PageTemplate);
          }}
        >
          <option value="">{t('add')}</option>
          {templates.map(({ template }) => (
            <option key={template} value={template}>
              {t(`templates.${template}` as never)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

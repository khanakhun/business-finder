'use client';

import type { SiteVersionDiff } from '@bf/contracts';
import type { BlockType } from '@bf/site-schema';
import { useTranslations } from 'next-intl';
import type * as React from 'react';
import { useConfigLabels } from '../labels.ts';

// What changed between two versions (BF-035's structural diff), for people: pages and sections added, removed,
// moved or changed, the site-wide parts touched, and every text before and after, per language.

function Group({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A path of the spec, readable: `pages › 0 › blocks › 2 › props › title`. */
const readablePath = (path: readonly (string | number)[]) => path.join(' › ');

export function DiffView({ diff }: { readonly diff: SiteVersionDiff }) {
  const t = useTranslations('siteEditor.versions.diff');
  const labels = useConfigLabels();
  const block = (type: string) => labels.block(type as BlockType);
  const { pages, blocks, texts, sections } = diff;
  const empty =
    pages.added.length +
      pages.removed.length +
      blocks.added.length +
      blocks.removed.length +
      blocks.moved.length +
      blocks.changed.length +
      texts.length +
      sections.length ===
    0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">{diff.summary}</p>
      {empty ? <p className="text-muted-foreground text-sm">{t('none')}</p> : null}
      {sections.length > 0 ? (
        <Group title={t('sections')}>
          <ul className="flex flex-wrap gap-1 text-sm">
            {sections.map((section) => (
              <li key={section} className="bg-muted rounded px-2 py-0.5">
                {t.has(`parts.${section}` as never) ? t(`parts.${section}` as never) : section}
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
      {pages.added.length + pages.removed.length > 0 ? (
        <Group title={t('pages')}>
          <ul className="list-disc pl-5 text-sm">
            {pages.added.map((page) => (
              <li key={`+${page}`}>{t('pageAdded', { page })}</li>
            ))}
            {pages.removed.map((page) => (
              <li key={`-${page}`}>{t('pageRemoved', { page })}</li>
            ))}
          </ul>
        </Group>
      ) : null}
      {blocks.added.length + blocks.removed.length + blocks.moved.length + blocks.changed.length > 0 ? (
        <Group title={t('blocks')}>
          <ul className="list-disc pl-5 text-sm">
            {blocks.added.map((ref) => (
              <li key={`+${ref.blockId}`}>{t('blockAdded', { block: block(ref.type), page: ref.pageId })}</li>
            ))}
            {blocks.removed.map((ref) => (
              <li key={`-${ref.blockId}`}>
                {t('blockRemoved', { block: block(ref.type), page: ref.pageId })}
              </li>
            ))}
            {blocks.moved.map((ref) => (
              <li key={`~${ref.blockId}`}>
                {t('blockMoved', {
                  block: block(ref.type),
                  page: ref.pageId,
                  from: ref.fromIndex + 1,
                  to: ref.toIndex + 1,
                })}
              </li>
            ))}
            {blocks.changed.map((ref) => (
              <li key={`*${ref.blockId}`}>
                {t('blockChanged', {
                  block: block(ref.type),
                  page: ref.pageId,
                  fields: ref.fields.map((field) => labels.field(field)).join(', '),
                })}
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
      {texts.length > 0 ? (
        <Group title={t('texts', { count: texts.length })}>
          <ul className="flex flex-col gap-2">
            {texts.map((text) => (
              <li key={`${readablePath(text.path)}:${text.locale}`} className="rounded border p-2 text-sm">
                <p className="text-muted-foreground mb-1 text-xs">
                  {readablePath(text.path)} · {text.locale.toUpperCase()}
                </p>
                {/* Old and new text side by side; the colours are doubled by words for colour-blind readers. */}
                <p>
                  <span className="sr-only">{t('before')}: </span>
                  {text.before === null ? (
                    <em className="text-muted-foreground">{t('noText')}</em>
                  ) : (
                    <del
                      className="bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100"
                      lang={text.locale}
                    >
                      {text.before}
                    </del>
                  )}
                </p>
                <p>
                  <span className="sr-only">{t('after')}: </span>
                  {text.after === null ? (
                    <em className="text-muted-foreground">{t('noText')}</em>
                  ) : (
                    <ins
                      className="bg-green-50 text-green-900 no-underline dark:bg-green-950 dark:text-green-100"
                      lang={text.locale}
                    >
                      {text.after}
                    </ins>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}
    </div>
  );
}

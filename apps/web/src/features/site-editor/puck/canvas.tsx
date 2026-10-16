'use client';

import {
  BlockRenderer,
  createRenderContext,
  Footer,
  Header,
  PreviewBanner,
  type RenderOptions,
  type SiteLinkProps,
  themeDataAttributes,
  themeToCssVars,
} from '@bf/site-blocks';
import { BLOCK_SCHEMAS, type BlockType } from '@bf/site-schema';
import { createUsePuck } from '@puckeditor/core';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { itemToBlock } from '../adapters/puck-to-ops.ts';
import { type BlockItemProps, findPage } from '../adapters/spec-to-puck.ts';
import { useSiteEditor } from '../context.tsx';

// The canvas (BF-037): the block library's own components, in the site's theme, inside Puck's iframe with the
// renderer's stylesheet only — what the editor shows is what apps/sites serves. Links do not navigate; the page
// chrome (banner, header, footer) frames the blocks as SitePage does.

const usePuck = createUsePuck();

/** A link on the canvas: shown as on the site, inert (a click selects, never leaves the editor). */
function CanvasLink({ href, children, ...rest }: SiteLinkProps) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

const OPTIONS: RenderOptions = { preview: true, mode: 'production', linkComponent: CanvasLink };

function useRenderContext() {
  const { spec, pageId, locale } = useSiteEditor();
  return React.useMemo(
    () => createRenderContext(spec, findPage(spec, pageId), locale, OPTIONS),
    [spec, pageId, locale],
  );
}

/** The page around the blocks: the site's theme, its banner, header and footer. */
export function CanvasRoot({ children }: { readonly children: React.ReactNode }) {
  const { spec, locale } = useSiteEditor();
  const ctx = useRenderContext();
  return (
    <div
      className="bf-site"
      lang={locale}
      style={themeToCssVars(spec.theme) as React.CSSProperties}
      {...themeDataAttributes(spec.theme)}
    >
      <PreviewBanner ctx={ctx} />
      <Header ctx={ctx} />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer ctx={ctx} />
    </div>
  );
}

/** One block as the site renders it, with the alternating tone its place on the page gives it. */
export function CanvasBlock({ type, props }: { readonly type: BlockType; readonly props: BlockItemProps }) {
  const ctx = useRenderContext();
  const content = usePuck((state) => state.appState.data.content);
  const index = content.findIndex((item) => item.props.id === props.id);
  // Tones alternate by position among the non-hero blocks (blockTones in the library).
  let tone: 'base' | 'alt' | undefined;
  if (type !== 'hero') {
    const before = content.slice(0, Math.max(index, 0) + 1).filter((item) => item.type !== 'hero').length;
    tone = before % 2 === 1 ? 'alt' : 'base';
  }
  // Puck adds its own render props (`puck`, `editMode`): the block gets its schema's keys only.
  const own = Object.keys(BLOCK_SCHEMAS[type].shape.props.shape);
  const block = itemToBlock({
    type,
    props: Object.fromEntries(
      Object.entries(props).filter(([key]) => key === 'id' || key === 'variant' || own.includes(key)),
    ) as BlockItemProps,
  });
  // The library's blocks expect valid props: an item being written (a cleared required text, an empty list) shows a
  // placeholder until it is complete, and the boundary keeps any other failure to this block.
  const valid = BLOCK_SCHEMAS[type].shape.props.safeParse(block.props).success;
  if (!valid) return <IncompleteBlock />;
  return (
    <BlockBoundary key={JSON.stringify(block.props)}>
      <BlockRenderer block={block} ctx={ctx} index={Math.max(index, 0)} tone={tone} />
    </BlockBoundary>
  );
}

/** A block the canvas cannot show yet (its fields say what is missing). */
function IncompleteBlock() {
  const t = useTranslations('siteEditor');
  return (
    <section
      role="note"
      style={{ padding: '2rem 1.5rem', border: '2px dashed currentColor', opacity: 0.6, textAlign: 'center' }}
    >
      {t('incompleteBlock')}
    </section>
  );
}

class BlockBoundary extends React.Component<{ readonly children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <IncompleteBlock /> : this.props.children;
  }
}

/** Where the canvas's stylesheet is (scripts/next.mjs copies the block library's build there). */
export const CANVAS_STYLESHEET = '/_bf/site-blocks.css';

/**
 * Puck's iframe with the block library's stylesheet only (never the dashboard's: `syncHostStyles` is off), so the
 * canvas matches the published page and the dashboard's styles never leak into it.
 */
export function CanvasFrame({
  children,
  document: frame,
}: {
  readonly children: React.ReactNode;
  readonly document?: Document | undefined;
}) {
  React.useEffect(() => {
    if (!frame || frame.querySelector('link[data-bf-canvas]')) return;
    const link = frame.createElement('link');
    link.rel = 'stylesheet';
    link.href = CANVAS_STYLESHEET;
    link.dataset.bfCanvas = '';
    frame.head.append(link);
    frame.body.style.margin = '0';
  }, [frame]);
  return <>{children}</>;
}

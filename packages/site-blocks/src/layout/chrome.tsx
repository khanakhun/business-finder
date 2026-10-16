import type { RenderContext } from '../renderer/types.ts';

/** The first focusable element: jumps over the header to the page's content. */
export function SkipLink({ ctx }: { ctx: RenderContext }) {
  return (
    <a href="#main" className="bf-skip">
      {ctx.strings.skipToContent}
    </a>
  );
}

/** The "concept preview" banner of previews (ADR-0009): this is not the business's official site. */
export function PreviewBanner({ ctx }: { ctx: RenderContext }) {
  if (!ctx.spec.settings.previewBanner && !ctx.options.preview) return null;
  const { brand } = ctx.spec;
  const agency = ctx.options.agencyName;
  return (
    <aside aria-label={ctx.strings.previewLabel} className="bf-preview-banner">
      {agency ? ctx.strings.previewBannerBy(brand.name, agency) : ctx.strings.previewBanner(brand.name)}
    </aside>
  );
}

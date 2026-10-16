import type { RendererStrings } from '@/lib/strings.ts';

/**
 * A preview's own bar (not part of the site): what the business can do with it. Plain links, keyboard reachable,
 * in the page's flow (it pushes the site down, never covers it). Shown only when at least one URL is configured.
 */
export function PreviewActions({
  links,
  business,
  strings,
}: {
  links: { claim?: string; optOut?: string };
  business: string;
  strings: RendererStrings;
}) {
  if (!links.claim && !links.optOut) return null;
  return (
    <nav aria-label={strings.previewActionsLabel(business)} className="bf-preview-actions">
      <span>{strings.previewActionsLabel(business)}</span>
      {links.claim ? <a href={links.claim}>{strings.claim}</a> : null}
      {links.optOut ? (
        <a href={links.optOut} rel="nofollow">
          {strings.optOut}
        </a>
      ) : null}
    </nav>
  );
}

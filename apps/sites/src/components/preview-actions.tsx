import type { RendererStrings } from '@/lib/strings.ts';

/**
 * A preview's actions, inside the block library's preview banner (its landmark names it): plain links, keyboard
 * reachable right after the skip link, in the page's flow (they push the site down, never cover it).
 */
export function PreviewActions({
  links,
  strings,
}: {
  links: { claim: string; optOut: string };
  strings: RendererStrings;
}) {
  return (
    <span className="bf-preview-actions">
      <a href={links.claim}>{strings.claim}</a>
      <a href={links.optOut} rel="nofollow">
        {strings.optOut}
      </a>
    </span>
  );
}

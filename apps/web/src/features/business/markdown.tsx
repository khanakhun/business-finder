'use client';

import ReactMarkdown, { type Components } from 'react-markdown';

// Notes are written by teammates but rendered for everyone: markdown only, never raw HTML (react-markdown escapes
// it; `skipHtml` drops it), no images (tracking pixels), and links only through react-markdown's safe URL
// transform (no `javascript:`), opened without referrer.
const ALLOWED = [
  'p',
  'br',
  'strong',
  'em',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
];

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-lagoon underline">
      {children}
    </a>
  ),
  h1: ({ children }) => <p className="font-semibold">{children}</p>,
  h2: ({ children }) => <p className="font-semibold">{children}</p>,
  h3: ({ children }) => <p className="font-semibold">{children}</p>,
  h4: ({ children }) => <p className="font-semibold">{children}</p>,
};

/** A note's markdown, sanitized (see above). */
export function SafeMarkdown({ children }: { readonly children: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-surface-sunken [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown skipHtml allowedElements={ALLOWED} unwrapDisallowed components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

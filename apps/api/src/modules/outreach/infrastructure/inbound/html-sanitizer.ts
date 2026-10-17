import { Injectable } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import type { HtmlSanitizer } from '../../application/inbound/ports.ts';

// Inbound HTML is untrusted (BF-054, security.md §3): sanitized server-side to a small allow-list — no scripts,
// styles, forms, iframes or event handlers; links keep http(s)/mailto/tel only and open in a new tab without a
// referrer. Remote images are replaced by a placeholder (tracking and privacy); inline `data:` and `cid:` images are
// dropped too. The web app renders the result in a sandboxed iframe with a strict CSP as a second line of defence.

const REMOTE = /^(https?:)?\/\//i;

@Injectable()
export class SanitizeHtmlSanitizer implements HtmlSanitizer {
  sanitize(html: string): { html: string; hasRemoteImages: boolean } {
    let hasRemoteImages = false;
    const clean = sanitizeHtml(html, {
      allowedTags: [
        ...sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'img'),
        'img',
        'span',
        'font',
        'center',
      ],
      allowedAttributes: {
        a: ['href', 'title'],
        img: ['alt', 'width', 'height', 'data-remote-src'],
        td: ['colspan', 'rowspan', 'align', 'valign'],
        th: ['colspan', 'rowspan', 'align', 'valign'],
        table: ['width', 'cellpadding', 'cellspacing', 'border'],
        '*': ['dir', 'lang'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'tel'],
      allowedSchemesByTag: { img: [] },
      disallowedTagsMode: 'discard',
      transformTags: {
        a: (tagName, attribs) => ({
          tagName,
          attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
        }),
        img: (tagName, attribs) => {
          const src = attribs.src ?? '';
          if (REMOTE.test(src)) {
            hasRemoteImages = true;
            // Kept aside: "show images" in the UI loads it on request.
            return { tagName, attribs: { alt: attribs.alt ?? '', 'data-remote-src': src } };
          }
          return { tagName: 'span', attribs: {} };
        },
      },
    });
    return { html: clean, hasRemoteImages };
  }

  /** Plain text of an HTML-only message: block ends become line breaks, tags and entities removed. */
  toText(html: string): string {
    const blocks = html.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '$&\n');
    return sanitizeHtml(blocks, { allowedTags: [], allowedAttributes: {} })
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

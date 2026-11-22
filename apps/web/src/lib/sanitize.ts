'use client';

import DOMPurify from 'dompurify';

/**
 * Message rendering uses React text nodes, which are already escaped. This
 * helper exists for the few places that accept a limited markup subset (link
 * previews, system notices), and is deliberately stricter than DOMPurify's
 * defaults: no tags at all, no attributes, no data URIs.
 */
export function sanitizeText(input: string): string {
  if (typeof window === 'undefined') return input.replace(/[<>]/g, '');
  return DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
  });
}

/** Only http(s) links survive; javascript:, data: and file: are dropped. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

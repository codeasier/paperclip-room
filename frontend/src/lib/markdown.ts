/**
 * Elements whose whole content CommonMark treats as raw HTML are dropped by
 * react-markdown's `skipHtml`, including the text inside them.
 */
const RAW_HTML_BLOCK = /<(script|pre|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
/**
 * A tag-like sequence. Markdown autolinks such as `<https://example.com>` and
 * `<name@example.com>` are deliberately not matched: their first token is
 * followed by `:` or `@`, not by whitespace, `/` or `>`.
 */
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;

/**
 * True when `skipHtml` would leave nothing to render: the message is not blank
 * but consists only of HTML tags, comments or raw-text blocks. Such messages
 * fall back to escaped plain text instead of producing an empty bubble.
 */
export function isHtmlOnly(text: string): boolean {
  if (!text.trim()) return false;
  const withoutRawHtml = text.replace(HTML_COMMENT, '').replace(RAW_HTML_BLOCK, '');
  return withoutRawHtml.replace(HTML_TAG, '').trim().length === 0;
}

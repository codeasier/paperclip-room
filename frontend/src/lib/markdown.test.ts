import { describe, expect, it } from 'vitest';
import { isHtmlOnly } from './markdown';

describe('isHtmlOnly', () => {
  it('detects html-only messages that skipHtml would erase', () => {
    expect(isHtmlOnly('<img src=x onerror=alert(1)>')).toBe(true);
    expect(isHtmlOnly('<div></div>')).toBe(true);
    expect(isHtmlOnly('<br/>')).toBe(true);
    expect(isHtmlOnly('<!-- comment -->')).toBe(true);
    expect(isHtmlOnly('<script>alert(1)</script>')).toBe(true);
    expect(isHtmlOnly('<style>body{}</style>')).toBe(true);
  });

  it('keeps ordinary text and mixed content on the markdown path', () => {
    expect(isHtmlOnly('请按下列做：')).toBe(false);
    expect(isHtmlOnly('看看 <img src=x> 结尾')).toBe(false);
    expect(isHtmlOnly('**bold** and `code`')).toBe(false);
    expect(isHtmlOnly('   ')).toBe(false);
    expect(isHtmlOnly('')).toBe(false);
  });

  it('does not mistake markdown autolinks or code for raw html', () => {
    expect(isHtmlOnly('<https://example.com>')).toBe(false);
    expect(isHtmlOnly('<name@example.com>')).toBe(false);
    expect(isHtmlOnly('`<img src=x>`')).toBe(false);
    expect(isHtmlOnly(['```html', '<div></div>', '```'].join('\n'))).toBe(false);
  });
});

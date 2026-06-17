import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown-to-html.js';

describe('markdownToHtml — URL auto-linking', () => {
  it('wraps a bare https URL in an anchor tag', () => {
    const result = markdownToHtml('Visit https://example.com for more.');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('wraps a bare http URL in an anchor tag', () => {
    const result = markdownToHtml('See http://example.com');
    expect(result).toContain('<a href="http://example.com"');
  });

  it('does not linkify URLs inside inline code spans', () => {
    const result = markdownToHtml('Run `https://example.com`');
    // URL is inside <code>, not inside an <a>
    expect(result).toContain('<code>https://example.com</code>');
    expect(result).not.toContain('<a href="https://example.com"');
  });

  it('linkifies a URL that contains query parameters', () => {
    const result = markdownToHtml('Go to https://example.com?a=1&b=2 now');
    // & is escaped to &amp; before URL detection runs
    expect(result).toContain('<a href="https://example.com?a=1&amp;b=2"');
  });

  it('linkifies URLs inside bold text', () => {
    const result = markdownToHtml('See **https://example.com**');
    expect(result).toContain('<a href="https://example.com"');
  });

  it('does not break non-URL text', () => {
    const result = markdownToHtml('Hello world');
    expect(result).toBe('<p>Hello world</p>');
  });

  it('strips trailing punctuation from linked URLs', () => {
    const result = markdownToHtml('Visit https://example.com. for more');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).not.toContain('<a href="https://example.com."');
  });

  it('preserves balanced parentheses inside URLs', () => {
    const result = markdownToHtml('See https://en.wikipedia.org/wiki/Function_(mathematics) here');
    expect(result).toContain('<a href="https://en.wikipedia.org/wiki/Function_(mathematics)"');
  });

  it('does not linkify javascript: or data: URIs', () => {
    const result = markdownToHtml('Try javascript:alert(1) or data:text/html,x');
    expect(result).not.toContain('<a href="javascript:');
    expect(result).not.toContain('<a href="data:');
  });

  it('does not inject content after a double quote into the href attribute', () => {
    // The URL regex [^\s<>"] stops at " so the href value only contains the URL portion.
    // This validates the regex boundary; the &quot; encoding in hrefValue (and now also
    // in escapeHtml) provides defense-in-depth against future regex relaxation.
    const result = markdownToHtml('Visit https://example.com" onclick="alert(1)');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).not.toContain('href="https://example.com" onclick=');
  });
});

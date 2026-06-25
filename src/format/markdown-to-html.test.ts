import { describe, expect, it } from 'vitest';
import { looksLikeHtml, markdownToHtml } from './markdown-to-html.js';

describe('markdownToHtml', () => {
  it('renders markdown links as clickable anchors', () => {
    const result = markdownToHtml('[Michaël Bijaoui](https://www.linkedin.com/in/michaelbijaoui)');

    expect(result).toContain('<a href="https://www.linkedin.com/in/michaelbijaoui"');
    expect(result).toContain('>Michaël Bijaoui</a>');
  });

  it('autolinks bare URLs for chat rendering', () => {
    const result = markdownToHtml('Visit https://example.com for more.');

    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
  });

  it('autolinks bare URLs inside the email wrapper', () => {
    const result = markdownToHtml('Visit https://example.com for more.', { wrap: true });

    expect(result).toMatch(/^<div style="font-family: Arial/);
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toMatch(/<\/div>$/);
  });

  it('preserves existing markdown formatting features', () => {
    const result = markdownToHtml([
      'First paragraph',
      'wrapped line',
      '',
      '**Bold** and *italic* with `code`',
      '',
      '- Item one',
      '- Item two',
      '',
      '---',
      '',
      'Final paragraph',
    ].join('\n'));

    expect(result).toContain('<p>First paragraph<br />\nwrapped line</p>');
    expect(result).toContain('<strong>Bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<code>code</code>');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<li>Item two</li>');
    expect(result).toContain('<hr />');
    expect(result).toContain('<p>Final paragraph</p>');
  });

  it('does not treat underscores inside words as emphasis', () => {
    const result = markdownToHtml('some_var_name is not italic');

    expect(result).toContain('some_var_name');
    expect(result).not.toContain('<em>');
  });

  it('does not linkify URLs inside inline code spans', () => {
    const result = markdownToHtml('Run `https://example.com`');

    expect(result).toContain('<code>https://example.com</code>');
    expect(result).not.toContain('<a href="https://example.com"');
  });

  it('preserves markdown tables', () => {
    const result = markdownToHtml([
      '| Name | Status |',
      '| --- | --- |',
      '| Curia | Ready |',
    ].join('\n'));

    expect(result).toContain('<table>');
    expect(result).toContain('<th>Name</th>');
    expect(result).toContain('<th>Status</th>');
    expect(result).toContain('<td>Curia</td>');
    expect(result).toContain('<td>Ready</td>');
  });

  it('strips unsafe link schemes from markdown links', () => {
    const result = markdownToHtml('[x](javascript:alert(1)) [y](data:text/html,x)');

    expect(result).not.toContain('href="javascript:');
    expect(result).not.toContain('href="data:');
  });

  it('sanitizes direct HTML without double-escaping it', () => {
    const result = markdownToHtml('<p>Hello <strong>there</strong></p><script>alert(1)</script>');

    expect(result).toContain('<p>Hello <strong>there</strong></p>');
    expect(result).not.toContain('&lt;p&gt;');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(1)');
  });

  it('preserves sanitized direct HTML tables', () => {
    const result = markdownToHtml(
      '<table onclick="alert(1)"><tr><th scope="col">Name</th><td style="text-align:center">Curia</td></tr></table>',
    );

    expect(result).toContain('<table>');
    expect(result).toContain('<th scope="col">Name</th>');
    expect(result).toContain('<td style="text-align:center">Curia</td>');
    expect(result).not.toContain('onclick');
  });

  it('escapes raw HTML in markdown input', () => {
    const result = markdownToHtml('a < b & c > d');

    expect(result).toContain('a &lt; b &amp; c &gt; d');
    expect(result).not.toContain('<b>');
  });
});

describe('looksLikeHtml', () => {
  it('detects block-level HTML bodies', () => {
    expect(looksLikeHtml('<p>Hello</p>')).toBe(true);
    expect(looksLikeHtml('<DIV>content</DIV>')).toBe(true);
  });

  it('does not treat plain markdown as HTML', () => {
    expect(looksLikeHtml('Hello **there**\n\n- one')).toBe(false);
  });
});

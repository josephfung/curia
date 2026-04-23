import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../../../../src/channels/email/markdown-to-html.js';

describe('markdownToHtml', () => {
  it('wraps plain text in a paragraph', () => {
    const result = markdownToHtml('Hello world');
    expect(result).toContain('<p>Hello world</p>');
  });

  it('converts double newlines into separate paragraphs', () => {
    const result = markdownToHtml('First paragraph\n\nSecond paragraph');
    expect(result).toContain('<p>First paragraph</p>');
    expect(result).toContain('<p>Second paragraph</p>');
  });

  it('treats blank lines containing only spaces as paragraph separators', () => {
    // LLMs sometimes emit blank lines with trailing spaces; these should still split blocks
    const result = markdownToHtml('First paragraph\n   \nSecond paragraph');
    expect(result).toContain('<p>First paragraph</p>');
    expect(result).toContain('<p>Second paragraph</p>');
  });

  it('converts single newlines to <br> within a paragraph', () => {
    const result = markdownToHtml('Line one\nLine two');
    expect(result).toContain('Line one<br>Line two');
  });

  it('converts **bold** to <strong>', () => {
    const result = markdownToHtml('This is **bold** text');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('converts __bold__ to <strong>', () => {
    const result = markdownToHtml('This is __bold__ text');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('converts *italic* to <em>', () => {
    const result = markdownToHtml('This is *italic* text');
    expect(result).toContain('<em>italic</em>');
  });

  it('converts _italic_ to <em>', () => {
    const result = markdownToHtml('This is _italic_ text');
    expect(result).toContain('<em>italic</em>');
  });

  it('converts inline code to <code>', () => {
    const result = markdownToHtml('Use `foo()` here');
    expect(result).toContain('<code>foo()</code>');
  });

  it('converts unordered list (dash) to <ul><li> tags', () => {
    const result = markdownToHtml('- Item one\n- Item two\n- Item three');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<li>Item two</li>');
    expect(result).toContain('<li>Item three</li>');
    expect(result).toContain('</ul>');
  });

  it('converts unordered list (asterisk) to <ul><li> tags', () => {
    const result = markdownToHtml('* First\n* Second');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>First</li>');
    expect(result).toContain('<li>Second</li>');
  });

  it('renders a realistic email body correctly', () => {
    // Blank lines between paragraphs and list blocks (standard markdown)
    const body = [
      'Hi Alex,',
      '',
      "Here's what you have on your weekend agenda:",
      '',
      '**Saturday, April 5th:**',
      '',
      '- Derek\'s Birthday (all-day event)',
      '- Preply lesson — Feng Jie F. (Chinese lesson via Preply platform)',
      '- WNBA presale window (ticket sales window)',
      '',
      '**Sunday, April 6th:**',
      '',
      '- Alex + Hamilton Catchup (meeting with Hamilton Petropoulos from Generation Capital via Google Meet)',
      '',
      'You have a nice mix of personal and business items.',
    ].join('\n');

    const result = markdownToHtml(body);

    // Paragraphs are wrapped
    expect(result).toContain('<p>Hi Alex,</p>');
    // Bold markers are converted
    expect(result).toContain('<strong>Saturday, April 5th:</strong>');
    expect(result).toContain('<strong>Sunday, April 6th:</strong>');
    // List items (apostrophe is not escaped — only < > & are)
    expect(result).toContain("<li>Derek's Birthday (all-day event)</li>");
    // No raw ** in output
    expect(result).not.toContain('**');
  });

  it('HTML-escapes < > & in text content to prevent tag injection', () => {
    const result = markdownToHtml('a < b & c > d');
    expect(result).toContain('a &lt; b &amp; c &gt; d');
    // Raw angle brackets must not appear as tags
    expect(result).not.toMatch(/<b>/);
  });

  it('converts horizontal rules (--- and ***)', () => {
    expect(markdownToHtml('Before\n\n---\n\nAfter')).toContain('<hr>');
    expect(markdownToHtml('Before\n\n***\n\nAfter')).toContain('<hr>');
  });

  it('does NOT convert mixed-character strings as horizontal rules', () => {
    // "-*-" and "--*" are not valid HR markers
    const result = markdownToHtml('-*-');
    expect(result).not.toContain('<hr>');
    expect(result).toContain('-*-');
  });

  it('does NOT convert underscores inside words to italic', () => {
    const result = markdownToHtml('some_variable_name is not italic');
    expect(result).not.toContain('<em>');
    expect(result).toContain('some_variable_name');
  });

  it('returns a string with the outer wrapper div', () => {
    const result = markdownToHtml('Hello');
    expect(result).toMatch(/^<div/);
    expect(result).toMatch(/<\/div>$/);
  });
});

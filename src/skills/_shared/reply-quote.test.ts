import { describe, it, expect } from 'vitest';
import { buildReplyQuote, type QuoteableMessage } from './reply-quote.js';

// Fixed Unix timestamp: 2025-05-21 19:42:00 UTC
// In America/Toronto (EDT, UTC-4): 2025-05-21, 3:42 PM EDT
const FIXED_DATE = 1747856520;

function makeMessage(overrides?: Partial<QuoteableMessage>): QuoteableMessage {
  return {
    from: [{ name: 'Alice Example', email: 'alice@example.com' }],
    to: [{ email: 'joseph@josephfung.ca' }],
    date: FIXED_DATE,
    subject: 'Re: Q2 planning',
    body: '<p>Let me know your thoughts.</p>',
    ...overrides,
  };
}

describe('buildReplyQuote', () => {
  // ---------------------------------------------------------------------------
  // Plain-text mode (default) — existing behaviour must be preserved
  // ---------------------------------------------------------------------------

  it('formats a complete quote with name and email', () => {
    const result = buildReplyQuote(makeMessage(), 'America/Toronto');

    expect(result).toContain('---------- Original Message ----------');
    expect(result).toContain('From: Alice Example <alice@example.com>');
    expect(result).toContain('To: joseph@josephfung.ca');
    expect(result).toContain('Subject: Re: Q2 planning');
    expect(result).toContain('Let me know your thoughts.');
    // Should start with double newline to separate from reply body
    expect(result.startsWith('\n\n')).toBe(true);
  });

  it('uses bare email when display name is absent', () => {
    const msg = makeMessage({ from: [{ email: 'alice@example.com' }] });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('From: alice@example.com');
    expect(result).not.toContain('From: undefined');
  });

  it('comma-separates multiple To recipients', () => {
    const msg = makeMessage({
      to: [
        { name: 'Bob', email: 'bob@example.com' },
        { email: 'carol@example.com' },
      ],
    });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('To: Bob <bob@example.com>, carol@example.com');
  });

  it('includes headers but omits body when original body is empty', () => {
    const msg = makeMessage({ body: '' });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('---------- Original Message ----------');
    expect(result).toContain('From:');
    expect(result).toContain('Subject:');
    // Should end after the Subject line (no trailing body content)
    const lines = result.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toMatch(/^Subject:/);
  });

  it('includes headers but omits body when HTML body strips to empty', () => {
    const msg = makeMessage({ body: '<p>  </p>' });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('---------- Original Message ----------');
    const lines = result.trimEnd().split('\n');
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toMatch(/^Subject:/);
  });

  it('comma-separates multiple senders', () => {
    const msg = makeMessage({
      from: [
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ],
    });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('From: Alice <alice@example.com>, Bob <bob@example.com>');
  });

  it('strips HTML from the original body', () => {
    const msg = makeMessage({ body: '<p>Hello <b>world</b></p>' });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('Hello world');
    expect(result).not.toContain('<p>');
    expect(result).not.toContain('<b>');
  });

  it('formats date with timezone abbreviation for America/Toronto', () => {
    const result = buildReplyQuote(makeMessage(), 'America/Toronto');

    // 1747856520 in EDT = 2026-05-21, 3:42 PM EDT
    expect(result).toContain('Date: 2025-05-21, 3:42 PM EDT');
  });

  it('falls back to UTC when timezone is omitted', () => {
    const result = buildReplyQuote(makeMessage());

    // 1747856520 in UTC = 2026-05-21, 7:42 PM UTC
    expect(result).toContain('Date: 2025-05-21, 7:42 PM UTC');
  });

  it('falls back to UTC when timezone is undefined', () => {
    const result = buildReplyQuote(makeMessage(), undefined);

    expect(result).toContain('Date: 2025-05-21, 7:42 PM UTC');
  });

  it('falls back to UTC when timezone is invalid (unsupported IANA zone)', () => {
    // Luxon creates an invalid DateTime for unrecognised IANA zone strings.
    // The two-step guard should retry with UTC so the date still renders correctly.
    const result = buildReplyQuote(makeMessage(), 'Mars/OlympusMons');

    expect(result).toContain('Date: 2025-05-21, 7:42 PM UTC');
    expect(result).not.toContain('Invalid DateTime');
  });

  it('uses "Unknown date" when date is NaN (e.g. Nylas returns a non-numeric field)', () => {
    // Luxon 3.x throws for non-number types (undefined), but accepts NaN (typeof 'number')
    // and returns an Invalid DateTime — the dt.isValid guard prevents 'Invalid DateTime'
    // from appearing in the quoted block sent to the recipient.
    const msg = makeMessage({ date: NaN });
    const result = buildReplyQuote(msg, 'America/Toronto');

    expect(result).toContain('Date: Unknown date');
    expect(result).not.toContain('Invalid DateTime');
  });

  // Regression: #733 — Outlook-on-Windows emails embed VML CSS in <style> blocks.
  // The old local htmlToPlainText() stripped only tags, leaving the CSS text visible.
  it('strips Outlook VML <style> block contents from the quoted body', () => {
    // Minimal but realistic Outlook HTML: a <style> block with VML CSS rules
    // followed by the actual message body. This is what enterprise senders produce.
    const outlookVmlHtml = [
      '<html><head>',
      '<style>',
      'v\\:* {behavior:url(#default#VML);}',
      'o\\:* {behavior:url(#default#VML);}',
      'w\\:* {behavior:url(#default#VML);}',
      '.shape {behavior:url(#default#VML);}',
      '</style>',
      '</head><body>',
      '<p>Hi Joseph,</p>',
      '<p>Let me know your thoughts on the proposal.</p>',
      '</body></html>',
    ].join('\n');

    const msg = makeMessage({ body: outlookVmlHtml });
    const result = buildReplyQuote(msg, 'America/Toronto');

    // VML CSS must not appear as visible text
    expect(result).not.toContain('behavior:url');
    expect(result).not.toContain('v\\:*');
    expect(result).not.toContain('{behavior');

    // Actual message text must survive
    expect(result).toContain('Hi Joseph');
    expect(result).toContain('Let me know your thoughts on the proposal.');
  });

  // ---------------------------------------------------------------------------
  // HTML mode — format: 'html'
  // ---------------------------------------------------------------------------

  describe('format: html', () => {
    it('wraps output in a blockquote with attribution headers', () => {
      const result = buildReplyQuote(makeMessage(), 'America/Toronto', { format: 'html' });

      expect(result).toContain('<blockquote');
      expect(result).toContain('</blockquote>');
      expect(result).toContain('<strong>From:</strong>');
      expect(result).toContain('<strong>Date:</strong>');
      expect(result).toContain('<strong>To:</strong>');
      expect(result).toContain('<strong>Subject:</strong>');
      // Should start with double newline to separate from reply body
      expect(result.startsWith('\n\n')).toBe(true);
    });

    it('HTML-escapes participant names and email addresses in headers', () => {
      const msg = makeMessage({
        from: [{ name: 'Alice & Bob', email: 'alice+bob@example.com' }],
      });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).toContain('Alice &amp; Bob');
      // Email address angle brackets rendered as entities in the attribution header
      expect(result).toContain('&lt;alice+bob@example.com&gt;');
      // Raw < and > must not appear unescaped in the header
      expect(result).not.toMatch(/<alice\+bob@example\.com>/);
    });

    it('HTML-escapes subject line', () => {
      const msg = makeMessage({ subject: 'Q2 <budget> & forecast' });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).toContain('Q2 &lt;budget&gt; &amp; forecast');
    });

    it('preserves bold and links from a Gmail-style HTML body', () => {
      const gmailHtml = '<p>Please review the <a href="https://example.com/doc">proposal</a> and the <b>Q2 numbers</b>.</p>';
      const msg = makeMessage({ body: gmailHtml });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).toContain('<a href="https://example.com/doc">proposal</a>');
      expect(result).toContain('<b>Q2 numbers</b>');
    });

    it('fully removes <script> tag and its content', () => {
      const xssHtml = '<p>Hello</p><script>alert(1)</script><p>World</p>';
      const msg = makeMessage({ body: xssHtml });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert(1)');
      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('strips onclick and other event-handler attributes', () => {
      const html = '<p onclick="evil()">Click me</p><a href="https://example.com" onmouseover="steal()">link</a>';
      const msg = makeMessage({ body: html });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).not.toContain('onclick');
      expect(result).not.toContain('onmouseover');
      expect(result).toContain('Click me');
      expect(result).toContain('link');
    });

    it('strips javascript: URLs from href attributes', () => {
      const html = '<a href="javascript:alert(1)">click</a>';
      const msg = makeMessage({ body: html });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).not.toContain('javascript:');
    });

    it('strips VML behavior: CSS from style attributes (Outlook fixture)', () => {
      // behavior: in an inline style attribute (not a <style> block) — the
      // transformTags sanitizer strips it while preserving other CSS.
      const outlookHtml = [
        '<p style="behavior:url(#default#VML);font-size:12pt">Meeting notes</p>',
        '<div style="font-family:Arial;behavior:url(#default#VML);">Content</div>',
      ].join('\n');
      const msg = makeMessage({ body: outlookHtml });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).not.toContain('behavior:url');
      expect(result).toContain('Meeting notes');
      expect(result).toContain('Content');
      // Harmless CSS properties should survive
      expect(result).toContain('font-size:12pt');
      expect(result).toContain('font-family:Arial');
    });

    it('strips <style> block content entirely (Outlook VML fixture)', () => {
      const outlookVmlHtml = [
        '<html><head>',
        '<style>v\\:* {behavior:url(#default#VML);}</style>',
        '</head><body>',
        '<p>Hi Joseph,</p>',
        '</body></html>',
      ].join('\n');
      const msg = makeMessage({ body: outlookVmlHtml });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).not.toContain('behavior:url');
      expect(result).toContain('Hi Joseph');
    });

    it('omits blockquote when sanitized body is empty', () => {
      const msg = makeMessage({ body: '<style>.x{}</style>' });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      // Headers must be present
      expect(result).toContain('<strong>From:</strong>');
      // No blockquote since body sanitised to empty
      expect(result).not.toContain('<blockquote');
    });

    it('omits blockquote when body is null or undefined', () => {
      for (const body of [null, undefined]) {
        const msg = makeMessage({ body });
        const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

        expect(result).toContain('<strong>From:</strong>');
        expect(result).not.toContain('<blockquote');
      }
    });

    it('includes date with timezone in HTML output', () => {
      const result = buildReplyQuote(makeMessage(), 'America/Toronto', { format: 'html' });

      expect(result).toContain('2025-05-21, 3:42 PM EDT');
    });

    it('comma-separates multiple recipients in HTML output', () => {
      const msg = makeMessage({
        to: [
          { name: 'Bob', email: 'bob@example.com' },
          { email: 'carol@example.com' },
        ],
      });
      const result = buildReplyQuote(msg, 'America/Toronto', { format: 'html' });

      expect(result).toContain('Bob');
      expect(result).toContain('carol@example.com');
    });
  });
});

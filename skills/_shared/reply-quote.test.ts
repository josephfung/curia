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
});

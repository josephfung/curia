import { describe, it, expect } from 'vitest';
import { splitReplyQuote, dropOwnIdentityItems } from '../../../../src/skills/principal-send/own-text.js';
import { REPLY_QUOTE_HTML_OPEN } from '../../../../src/skills/_shared/reply-quote.js';
import type { DetectedPii } from '../../../../src/dispatch/pii-redactor.js';

describe('splitReplyQuote', () => {
  it('splits on the reply quote Curia appends', () => {
    const html = `<p>Thanks, see you Friday.</p>${REPLY_QUOTE_HTML_OPEN}<p>From: Dana</p></div>`;
    expect(splitReplyQuote(html)).toEqual({
      own: '<p>Thanks, see you Friday.</p>',
      quote: `${REPLY_QUOTE_HTML_OPEN}<p>From: Dana</p></div>`,
    });
  });

  it('splits on a Gmail quote', () => {
    const html = '<div>Sounds good.</div><div class="gmail_quote">On Fri, Dana wrote: call 416-555-0100</div>';
    expect(splitReplyQuote(html)).toEqual({
      own: '<div>Sounds good.</div>',
      quote: '<div class="gmail_quote">On Fri, Dana wrote: call 416-555-0100</div>',
    });
  });

  it('splits at the earliest marker when both occur', () => {
    const html = `<p>Yes.</p><div class="gmail_quote">older</div>${REPLY_QUOTE_HTML_OPEN}newer</div>`;
    expect(splitReplyQuote(html).own).toBe('<p>Yes.</p>');
    const reversed = `<p>Yes.</p>${REPLY_QUOTE_HTML_OPEN}newer</div><div class="gmail_quote">older</div>`;
    expect(splitReplyQuote(reversed).own).toBe('<p>Yes.</p>');
  });

  it('returns an empty quote when there is no marker', () => {
    expect(splitReplyQuote('<p>Hello</p>')).toEqual({ own: '<p>Hello</p>', quote: '' });
  });
});

describe('dropOwnIdentityItems', () => {
  const item = (label: string, matched: string): DetectedPii => ({ label, matched, start: 0, end: matched.length });

  it('drops the principal\'s own email and phone, keeping others', () => {
    const items = [
      item('EMAIL', 'Avery@Example.com'),
      item('PHONE', '+1 (416) 555-0100'),
      item('PHONE', '416-555-0199'),
      item('EMAIL', 'dana@example.org'),
      item('SIN', '046 454 286'),
    ];
    const kept = dropOwnIdentityItems(items, ['avery@example.com', '14165550100']);
    expect(kept.map((i) => i.matched)).toEqual(['416-555-0199', 'dana@example.org', '046 454 286']);
  });

  it('matches a phone written without the country code against an E.164 identity', () => {
    const kept = dropOwnIdentityItems([item('PHONE', '(416) 555-0100')], ['+14165550100']);
    expect(kept).toEqual([]);
  });

  it('keeps everything when there are no identities', () => {
    const items = [item('EMAIL', 'avery@example.com')];
    expect(dropOwnIdentityItems(items, [])).toEqual(items);
  });
});

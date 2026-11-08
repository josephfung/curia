import { describe, it, expect } from 'vitest';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import type { DetectedPii } from '../../../../src/dispatch/pii-redactor.js';
import {
  comparableText, mailboxDraftLabel, quoteItemsToReview, quoteMatchesThread, replyOrigin, threadMessageProof, threadTextSeenByAll,
} from '../../../../src/skills/principal-send/quote-proof.js';

const PRINCIPAL = ['avery@example.com'];
const VERIFIED = [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass smtp.mailfrom=x; dkim=pass header.d=x; dmarc=pass header.from=x' }];

function msg(over: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'm1', threadId: 'th1', subject: 'Friday', from: [{ name: 'Dana Example', email: 'dana@example.org' }],
    to: [{ email: 'avery@example.com' }], cc: [], bcc: [], body: '<p>Does Friday work?</p><p>Dana<br>416-555-0199</p>',
    snippet: '', date: 1_762_500_000, unread: false, folders: ['INBOX'], attachments: [], headers: VERIFIED,
    ...over,
  } as NylasMessage;
}

/** Each listed text, found wherever it first occurs in `html` (the detector reads raw HTML). */
function found(html: string, texts: string[]): DetectedPii[] {
  return texts.map((t) => ({ label: t.includes('@') ? 'EMAIL' : 'PHONE_NUMBER', matched: t, start: html.indexOf(t), end: html.indexOf(t) + t.length }) as DetectedPii);
}

const HEADER = '<div><p><strong>From:</strong> Dana Example &lt;dana@example.org&gt;</p></div>';

describe('quoteItemsToReview (#2474 PR 2)', () => {
  const thread = [threadMessageProof(msg(), PRINCIPAL)];

  it('exempts a value the quoted message itself holds when every recipient was on it', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><p>Dana<br>416-555-0199</p></blockquote>`;
    expect(quoteItemsToReview(found(quote, ['416-555-0199', 'dana@example.org']), quote, thread, ['dana@example.org'])).toEqual([]);
  });

  it('reviews a value hidden in an HTML comment inside a genuine quote', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><!-- 416-555-0123 --><p>Dana<br>416-555-0199</p></blockquote>`;
    expect(quoteItemsToReview(found(quote, ['416-555-0123', '416-555-0199']), quote, thread, ['dana@example.org']).map((i) => i.matched)).toEqual(['416-555-0123']);
  });

  it('reviews a value hidden in an attribute inside a genuine quote', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><img src="https://x.example/?n=416-555-0123"><p>Dana<br>416-555-0199</p></blockquote>`;
    expect(quoteItemsToReview(found(quote, ['416-555-0123']), quote, thread, ['dana@example.org'])).toHaveLength(1);
  });

  it('reviews everything when a recipient of this send was not on the quoted message', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><p>Dana<br>416-555-0199</p></blockquote>`;
    const withBob = [threadMessageProof(msg(), PRINCIPAL), threadMessageProof(msg({ id: 'm2', from: [{ email: 'bob@example.org' }], body: '<p>Count me in.</p>' }), PRINCIPAL)];
    expect(quoteItemsToReview(found(quote, ['416-555-0199']), quote, withBob, ['dana@example.org', 'bob@example.org'])).toHaveLength(1);
  });

  it('picks the source by text and audience together', () => {
    const quote = '<blockquote>Does Friday work? 416-555-0199</blockquote>';
    const both = [
      threadMessageProof(msg({ body: 'Does Friday work? 416-555-0199' }), PRINCIPAL),
      // The principal's own forward to both: a SENT message, so its To/Cc received it.
      threadMessageProof(msg({
        id: 'm2', from: [{ email: 'avery@example.com' }], to: [{ email: 'dana@example.org' }], cc: [{ email: 'bob@example.org' }],
        folders: ['SENT'], body: 'Fwd: Does Friday work? 416-555-0199',
      }), PRINCIPAL),
    ];
    expect(quoteItemsToReview(found(quote, ['416-555-0199']), quote, both, ['dana@example.org', 'bob@example.org'])).toEqual([]);
  });

  it('reviews everything with no <blockquote>, an empty one, or text on no thread message', () => {
    for (const quote of [`${HEADER}416-555-0199`, `${HEADER.replace('Dana Example', '416-555-0199')}<blockquote> </blockquote>`, `${HEADER}<blockquote>Sam's cell is 416-555-0199</blockquote>`]) {
      expect(quoteItemsToReview(found(quote, ['416-555-0199']), quote, thread, ['dana@example.org'])).toHaveLength(1);
    }
  });
});

describe('comparableText', () => {
  it('collapses whitespace and lowercases the visible text', () => {
    expect(comparableText('<p>Does  Friday\n<b>WORK</b>?</p><!-- x -->')).toBe('does friday work?');
  });
});

describe('mailboxDraftLabel', () => {
  it('names non-principal recipients by display name, else address, once each', () => {
    const d = msg({ subject: 'Re: Friday', to: [{ name: 'Dana Example', email: 'Dana@example.org' }], cc: [{ email: 'avery@example.com' }, { email: 'sam@example.org' }], bcc: [{ email: 'dana@example.org' }] });
    expect(mailboxDraftLabel(d, (e) => e === 'avery@example.com')).toBe('"Re: Friday" to Dana Example, sam@example.org');
  });
});

describe('replyOrigin', () => {
  it('gives text, an ISO time and senderVerified from the message\'s own headers', () => {
    expect(replyOrigin(msg())).toEqual({ content: expect.stringContaining('Does Friday work?'), at: new Date(1_762_500_000_000).toISOString(), senderVerified: true });
    expect(replyOrigin(msg({ headers: undefined })).senderVerified).toBe(false);
  });
});

// Gap fix round 1 (I1): "on the thread" means a message every recipient of this send received.
describe('threadTextSeenByAll', () => {
  const fromDana = msg({ body: '<p>Does Friday work?</p>' });
  const toCfo = msg({
    id: 'm2', from: [{ email: 'avery@example.com' }], to: [{ email: 'cfo@example.com' }], cc: [],
    body: '<p>The multiple is 4.2x.</p>', date: 1_762_500_100, folders: ['SENT'],
  });
  const toBoth = msg({
    id: 'm3', from: [{ email: 'avery@example.com' }], to: [{ email: 'dana@example.org' }], cc: [{ email: 'Sam@Example.org' }],
    folders: ['SENT'], body: '<p>Sam, meet Dana.</p>',
  });

  it('keeps only messages every recipient received, case-insensitively', () => {
    expect(threadTextSeenByAll([fromDana, toCfo], ['dana@example.org'], PRINCIPAL)).toEqual([
      { at: new Date(fromDana.date * 1000).toISOString(), text: 'Does Friday work?' },
    ]);
    expect(threadTextSeenByAll([fromDana, toBoth], ['DANA@example.org', 'sam@example.org'], PRINCIPAL).map((m) => m.text)).toEqual(['Sam, meet Dana.']);
  });

  it('is empty when no message reached every recipient, or when there is no recipient (fail closed)', () => {
    expect(threadTextSeenByAll([toCfo], ['dana@example.org'], PRINCIPAL)).toEqual([]);
    expect(threadTextSeenByAll([fromDana], [], PRINCIPAL)).toEqual([]);
  });

  // Final fixes A2 (security review M3): an inbound header's Cc is a claim, not receipt.
  it('does not count a forged inbound Cc as received', () => {
    const forgedCc = msg({ cc: [{ email: 'cfo@example.com' }], body: '<p>New remittance details: DE89 3704 0044 0532 0130 00</p>' });
    expect(threadTextSeenByAll([forgedCc], ['dana@example.org', 'cfo@example.com'], PRINCIPAL)).toEqual([]);
  });
});

// Final fixes A2 (security review M3): a quoted message counts only if every recipient received it.
describe('received-by in the quote proof', () => {
  it('reviews a quoted item when the quoted inbound message only claims to Cc a recipient', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><p>Dana<br>416-555-0199</p></blockquote>`;
    const forgedCc = [threadMessageProof(msg({ cc: [{ email: 'cfo@example.com' }] }), PRINCIPAL)];
    expect(quoteItemsToReview(found(quote, ['416-555-0199']), quote, forgedCc, ['dana@example.org', 'cfo@example.com'])).toHaveLength(1);
  });

  it('counts a principal SENT message for each of its recipients', () => {
    const quote = '<blockquote><p>Agenda attached. Call 416-555-0199.</p></blockquote>';
    const sent = [threadMessageProof(msg({
      from: [{ email: 'avery@example.com' }], to: [{ email: 'dana@example.org' }], cc: [{ email: 'bob@example.org' }],
      folders: ['SENT'], body: '<p>Agenda attached. Call 416-555-0199.</p>',
    }), PRINCIPAL)];
    expect(quoteItemsToReview(found(quote, ['416-555-0199']), quote, sent, ['dana@example.org', 'bob@example.org'])).toEqual([]);
  });
});

// Final fixes A10 (security review B4): a quote's visible text must be on a message every recipient received.
describe('quoteMatchesThread', () => {
  const thread = [threadMessageProof(msg(), PRINCIPAL)];

  it('is true for a genuine quote of a message every recipient received', () => {
    const quote = `${HEADER}<blockquote><p>Does Friday work?</p><p>Dana<br>416-555-0199</p></blockquote>`;
    expect(quoteMatchesThread(quote, thread, ['dana@example.org'])).toBe(true);
  });

  it('is false for text on no thread message, a quote with no quoted body, or a recipient who never got it', () => {
    expect(quoteMatchesThread(`${HEADER}<blockquote>The multiple is 4.2x.</blockquote>`, thread, ['dana@example.org'])).toBe(false);
    expect(quoteMatchesThread(`${HEADER}Does Friday work?`, thread, ['dana@example.org'])).toBe(false);
    expect(quoteMatchesThread(`${HEADER}<blockquote> </blockquote>`, thread, ['dana@example.org'])).toBe(false);
    expect(quoteMatchesThread(`${HEADER}<blockquote><p>Does Friday work?</p></blockquote>`, thread, ['dana@example.org', 'bob@example.org'])).toBe(false);
  });
});

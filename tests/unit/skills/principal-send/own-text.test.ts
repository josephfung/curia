import { describe, it, expect } from 'vitest';
import { splitReplyQuote, dropOwnIdentityItems, quoteHeaderParticipants } from '../../../../src/skills/principal-send/own-text.js';
import { REPLY_QUOTE_HTML_OPEN, buildReplyQuote } from '../../../../src/skills/_shared/reply-quote.js';
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

  it('splits on Gmail\'s compound quote class, wherever the token sits in the class list', () => {
    const compound = '<div>Sounds good.</div><div class="gmail_quote gmail_quote_container">On Fri, Dana wrote:</div>';
    expect(splitReplyQuote(compound).own).toBe('<div>Sounds good.</div>');
    const later = '<div>Ok.</div><div dir="ltr" class="x gmail_quote">On Fri, Dana wrote:</div>';
    expect(splitReplyQuote(later).own).toBe('<div>Ok.</div>');
  });

  it('does not split on a class that only starts with gmail_quote', () => {
    const html = '<div>Ok.</div><div class="gmail_quoted">not a quote</div>';
    expect(splitReplyQuote(html)).toEqual({ own: html, quote: '' });
  });

  it('does not split on gmail_quote outside a div\'s own class attribute', () => {
    // Another attribute named like class, and class= text inside another attribute's value.
    for (const tag of [
      '<div data-class="gmail_quote">',
      '<div title=\'class="gmail_quote"\'>',
      '<div title="x" data-x=\'a class="gmail_quote"\'>',
      '<span class="gmail_quote">',
    ]) {
      const html = `<div>Ok, call 416-555-0199.</div>${tag}later text</div>`;
      expect(splitReplyQuote(html), tag).toEqual({ own: html, quote: '' });
    }
  });

  it('does not split on a quote marker inside an attribute value, a comment or a raw-text element', () => {
    for (const wrapped of [
      '<img alt=\'<div class="gmail_quote">\'>',
      `<img alt='${REPLY_QUOTE_HTML_OPEN}'>`,
      '<!-- <div class="gmail_quote"> -->',
      '<style>/* <div class="gmail_quote"> */</style>',
      // End tags carry attributes too: a '>' inside their quoted value does not close them.
      '</p x=\'<div class="gmail_quote">\'>',
      '</p x=\'>\'<div class="gmail_quote"><div class="gmail_attr">On Thu, Dana &lt;dana@example.org&gt; wrote:</div><blockquote>x</blockquote></div>\'>',
      `</span title=">${REPLY_QUOTE_HTML_OPEN}">`,
      // A raw-text element ends only at its own end tag, not at a longer name.
      '<script>x</scriptx><div class="gmail_quote"></script>',
      // Bogus comments end at the first '>', so a marker's own '>' closes them around it.
      '<?x <div class="gmail_quote">',
      `<?x ${REPLY_QUOTE_HTML_OPEN}`,
      '</ <div class="gmail_quote">',
      '<!x <div class="gmail_quote">',
      '<svg><![CDATA[ > <div class="gmail_quote"> ]]></svg>',
      // Every raw-text element, not only the common ones.
      ...['xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title'].map(
        (el) => `<${el}><div class="gmail_quote"></${el}>`,
      ),
      // plaintext never ends, even at a '</plaintext>'.
      '<plaintext>x</plaintext><div class="gmail_quote">',
      // A script's '<!--' escape can carry it past a '</script>'.
      '<script><!--<script></script><div class="gmail_quote"></script>',
    ]) {
      const html = `<p>Ok, call 416-555-0199.</p>${wrapped}<p>more</p>`;
      expect(splitReplyQuote(html), wrapped).toEqual({ own: html, quote: '' });
    }
  });

  it('still splits on a real quote after an attribute that mentions it', () => {
    const html = '<div title=\'class="gmail_quote"\'>Ok.</div><div class=\'gmail_quote\'>On Fri, Dana wrote:</div>';
    expect(splitReplyQuote(html).own).toBe('<div title=\'class="gmail_quote"\'>Ok.</div>');
  });

  it('still splits on a real quote after an end tag with a quoted attribute', () => {
    const html = '<p>Ok.</p x=\'>\'><div class="gmail_quote">On Fri, Dana wrote:</div>';
    expect(splitReplyQuote(html).own).toBe('<p>Ok.</p x=\'>\'>');
    const raw = '<style>p{}</style ><div class="gmail_quote">On Fri</div>';
    expect(splitReplyQuote(raw).own).toBe('<style>p{}</style >');
    const bogus = '<?xml x?><iframe>y</iframe><div class="gmail_quote">On Fri</div>';
    expect(splitReplyQuote(bogus).own).toBe('<?xml x?><iframe>y</iframe>');
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

describe('quoteHeaderParticipants (#2474 final review S2)', () => {
  it('reads From and To from the quote Curia builds', () => {
    const quote = buildReplyQuote({
      from: [{ name: 'Dana Wu', email: 'Dana@Example.org' }],
      to: [{ email: 'avery@example.com' }, { name: 'Sam', email: 'sam@example.org' }],
      date: 1794056400, subject: 'Friday', body: '<p>Write to lee@example.net, call 416-555-0199</p>',
    }, 'UTC', { format: 'html' }).trimStart();
    // The quoted body's own addresses are not participants.
    expect(quoteHeaderParticipants(quote)).toEqual(['dana@example.org', 'avery@example.com', 'sam@example.org']);
  });

  it('reads the sender from a Gmail attribution line', () => {
    const quote = '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Thu, Nov 6, 2026 at 9:00 AM Dana &lt;<a href="mailto:dana@example.org">dana@example.org</a>&gt; wrote:<br></div><blockquote class="gmail_quote">Call me: 416-555-0199. cc bob@example.net</blockquote></div>';
    expect(quoteHeaderParticipants(quote)).toEqual(['dana@example.org']);
  });

  it('reads the sender from a compound-class Gmail quote', () => {
    const quote = '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Thu, Dana &lt;<a href="mailto:dana@example.org">dana@example.org</a>&gt; wrote:<br></div><blockquote class="gmail_quote">Call me: 416-555-0199</blockquote></div>';
    expect(quoteHeaderParticipants(quote)).toEqual(['dana@example.org']);
  });

  it('is null when the header names nobody or cannot be found', () => {
    expect(quoteHeaderParticipants('<div class="gmail_quote">On Thu, Dana wrote: call 416-555-0199</div>')).toBeNull();
    expect(quoteHeaderParticipants('<div class="gmail_quote"><div class="gmail_attr">On Thu, Dana wrote:</div><blockquote>x</blockquote></div>')).toBeNull();
    expect(quoteHeaderParticipants('')).toBeNull();
    expect(quoteHeaderParticipants(`${REPLY_QUOTE_HTML_OPEN}<p>no header</p>`)).toBeNull();
    // Not a Gmail quote container: no attribution is read from it.
    expect(quoteHeaderParticipants('<div data-class="gmail_quote">On Thu, dana@example.org wrote:<blockquote>x</blockquote></div>')).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { decodeSlackText } from '../../../../src/channels/slack/slack-entities.js';

describe('decodeSlackText', () => {
  it('unescapes HTML entities', () => {
    expect(decodeSlackText('A &amp; B &lt;C&gt;')).toBe('A & B <C>');
  });

  it('does not double-unescape already-escaped entity sequences', () => {
    // Slack sends a user-typed literal "&lt;" as "&amp;lt;" — decoding must
    // yield the literal text "&lt;", not a further-unescaped "<".
    expect(decodeSlackText('&amp;lt;')).toBe('&lt;');
    expect(decodeSlackText('&amp;gt;')).toBe('&gt;');
    expect(decodeSlackText('&amp;amp;')).toBe('&amp;');
  });

  it('unwraps user and channel mentions', () => {
    expect(decodeSlackText('hi <@U123|alice> in <#C9|general>')).toBe(
      'hi @alice in #general',
    );
  });

  it('unwraps links', () => {
    expect(decodeSlackText('see <https://example.com|docs>')).toBe('see docs');
    expect(decodeSlackText('go <https://example.com>')).toBe('go https://example.com');
  });

  it('strips leading bot mention', () => {
    expect(decodeSlackText('<@U_BOT> schedule a sync', { botUserId: 'U_BOT' })).toBe(
      'schedule a sync',
    );
  });
});

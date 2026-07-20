import { describe, it, expect } from 'vitest';
import { decodeSlackText } from '../../../../src/channels/slack/slack-entities.js';

describe('decodeSlackText', () => {
  it('unescapes HTML entities', () => {
    expect(decodeSlackText('A &amp; B &lt;C&gt;')).toBe('A & B <C>');
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

import { describe, it, expect } from 'vitest';
import { parseSseEvent, makeMessage, formatTimestamp, linkifyText, mergeLiveTail, nextReconnectDelayMs, pickRecoveredReply } from './chat-utils.js';
import type { Message } from './types.js';

describe('parseSseEvent', () => {
  it('returns a status event for tool.invoke', () => {
    const data = JSON.stringify({ type: 'tool.invoke', tool: 'memory.recall', conversation_id: 'c1' });
    expect(parseSseEvent(data)).toEqual({ kind: 'status', text: 'invoking memory.recall' });
  });

  it('falls back to "tool" when the tool field is absent', () => {
    const data = JSON.stringify({ type: 'tool.invoke', conversation_id: 'c1' });
    expect(parseSseEvent(data)).toEqual({ kind: 'status', text: 'invoking tool' });
  });

  it('returns a reply event with content and html for message events', () => {
    const data = JSON.stringify({ type: 'message', content: 'Hello', html: '<p>Hello</p>' });
    expect(parseSseEvent(data)).toEqual({ kind: 'reply', text: 'Hello', html: '<p>Hello</p>' });
  });

  it('returns a reply event with html: null when html is absent', () => {
    const data = JSON.stringify({ type: 'message', content: 'Hi' });
    expect(parseSseEvent(data)).toEqual({ kind: 'reply', text: 'Hi', html: null });
  });

  it('returns a rejected event with friendly text for both rate-limit reasons', () => {
    // Both global_rate_limited and sender_rate_limited are real MessageRejectedEvent
    // reason codes and must get the friendly rate-limit copy.
    for (const reason of ['global_rate_limited', 'sender_rate_limited']) {
      const result = parseSseEvent(JSON.stringify({ type: 'message.rejected', reason }));
      expect(result?.kind).toBe('rejected');
      if (result?.kind !== 'rejected') throw new Error('expected rejected');
      expect(result.text).toMatch(/rate limit/i);
    }
  });

  it('returns a rejected event naming the reason for non-rate-limit reasons', () => {
    const result = parseSseEvent(JSON.stringify({ type: 'message.rejected', reason: 'blocked_sender' }));
    expect(result?.kind).toBe('rejected');
    if (result?.kind !== 'rejected') throw new Error('expected rejected');
    expect(result.text).toContain('blocked_sender');
  });

  it('returns a user event so another device can append the echo', () => {
    const data = JSON.stringify({
      type: 'user.message',
      content: 'from the phone',
      client_message_id: 'client-1',
    });
    expect(parseSseEvent(data)).toEqual({
      kind: 'user',
      text: 'from the phone',
      clientMessageId: 'client-1',
    });
  });

  it('returns null for tool.result events (not displayed)', () => {
    expect(parseSseEvent(JSON.stringify({ type: 'tool.result', skill: 'memory.recall' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseSseEvent('not-json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSseEvent('')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseSseEvent('42')).toBeNull();
    expect(parseSseEvent('"hello"')).toBeNull();
  });
});

describe('mergeLiveTail', () => {
  const user = (text: string, id = text): Message => ({ id, kind: 'user', text });
  const agent = (text: string, id = text): Message => ({ id, kind: 'agent', text });
  const status = (text: string, id = text): Message => ({ id, kind: 'status', text });

  it('keeps a turn that arrived live while history was loading', () => {
    const history = [user('older', 'h-older'), agent('reply', 'h-reply')];
    const live = [user('from the phone', 'live-phone')];
    expect(mergeLiveTail(history, live).map((m) => m.text)).toEqual(['older', 'reply', 'from the phone']);
  });

  it('keeps the live copy when history already contains the same turn', () => {
    const history = [user('older', 'h-older'), user('from the phone', 'h-phone')];
    const live = [user('from the phone', 'live-phone')];
    const merged = mergeLiveTail(history, live);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.id).toBe('live-phone');
  });

  it('does not duplicate a turn when a status row sits between the live messages', () => {
    const history = [user('question', 'h-user'), agent('answer', 'h-agent')];
    const live = [
      user('question', 'live-user'),
      status('invoking calendar', 'live-status'),
      agent('answer', 'live-agent'),
    ];
    const merged = mergeLiveTail(history, live);
    expect(merged.map((m) => m.id)).toEqual(['live-user', 'live-status', 'live-agent']);
  });
});

describe('nextReconnectDelayMs', () => {
  it('doubles from one second and stops at thirty', () => {
    expect(nextReconnectDelayMs(0)).toBe(1_000);
    expect(nextReconnectDelayMs(1)).toBe(2_000);
    expect(nextReconnectDelayMs(2)).toBe(4_000);
    expect(nextReconnectDelayMs(5)).toBe(30_000);
    expect(nextReconnectDelayMs(9)).toBe(30_000);
  });
});

describe('pickRecoveredReply', () => {
  // Timestamps are deliberately out of order vs. position to prove the function
  // relies on message ORDERING, not wall-clock comparison (clock-skew safe).
  it('returns the assistant reply that follows the last user message', () => {
    const items = [
      { id: '1', role: 'user' as const, content: 'q', html: null, timestamp: '2026-06-15T11:59:00Z' },
      { id: '2', role: 'assistant' as const, content: 'old', html: null, timestamp: '2026-06-15T11:59:30Z' },
      { id: '3', role: 'user' as const, content: 'q2', html: null, timestamp: '2026-06-15T12:00:00Z' },
      { id: '4', role: 'assistant' as const, content: 'fresh', html: '<p>fresh</p>', timestamp: '2026-06-15T12:03:00Z' },
    ];
    expect(pickRecoveredReply(items)).toEqual({ text: 'fresh', html: '<p>fresh</p>' });
  });

  it('returns the reply even when its server timestamp predates the user turn (clock skew)', () => {
    // Assistant row stamped BEFORE the user row — would be dropped by a wall-clock
    // comparison, but ordering correctly identifies it as the reply.
    const items = [
      { id: '1', role: 'user' as const, content: 'q', html: null, timestamp: '2026-06-15T12:00:05Z' },
      { id: '2', role: 'assistant' as const, content: 'reply', html: null, timestamp: '2026-06-15T12:00:00Z' },
    ];
    expect(pickRecoveredReply(items)).toEqual({ text: 'reply', html: null });
  });

  it('returns null when the latest turn is unanswered (history ends on a user message)', () => {
    const items = [
      { id: '1', role: 'user' as const, content: 'q', html: null, timestamp: '2026-06-15T11:00:00Z' },
      { id: '2', role: 'assistant' as const, content: 'prior reply', html: null, timestamp: '2026-06-15T11:00:30Z' },
      { id: '3', role: 'user' as const, content: 'q2', html: null, timestamp: '2026-06-15T12:00:00Z' },
    ];
    expect(pickRecoveredReply(items)).toBeNull();
  });

  it('returns null when there is no user turn', () => {
    const items = [
      { id: '1', role: 'assistant' as const, content: 'orphan', html: null, timestamp: '2026-06-15T12:00:00Z' },
    ];
    expect(pickRecoveredReply(items)).toBeNull();
  });

  it('returns null for an empty history page', () => {
    expect(pickRecoveredReply([])).toBeNull();
  });
});

describe('makeMessage', () => {
  it('returns a Message with the given kind and text', () => {
    const msg = makeMessage('user', 'hello');
    expect(msg.kind).toBe('user');
    expect(msg.text).toBe('hello');
    expect(typeof msg.id).toBe('string');
  });

  it('generates a unique id on each call', () => {
    const a = makeMessage('agent', 'x');
    const b = makeMessage('agent', 'x');
    expect(a.id).not.toBe(b.id);
  });

  it('forwards html and timestamp opts onto the message', () => {
    const ts = new Date('2026-05-30T09:24:00Z');
    const msg = makeMessage('agent', 'hi', { html: '<p>hi</p>', timestamp: ts });
    expect(msg.html).toBe('<p>hi</p>');
    expect(msg.timestamp).toBe(ts);
  });

  it('leaves html and timestamp undefined when opts are omitted', () => {
    const msg = makeMessage('user', 'hello');
    expect(msg.html).toBeUndefined();
    expect(msg.timestamp).toBeUndefined();
  });
});

describe('formatTimestamp', () => {
  it('returns "Today · <time>" for a timestamp from today', () => {
    const now = new Date();
    const result = formatTimestamp(now);
    expect(result).toMatch(/^Today · /);
  });

  it('returns "<Mon DD> · <time>" for a timestamp from a different day', () => {
    const old = new Date('2026-04-01T10:00:00');
    const result = formatTimestamp(old);
    // Should not start with "Today ·"
    expect(result).not.toMatch(/^Today · /);
    // Should contain a middle dot
    expect(result).toContain(' · ');
  });
});

describe('linkifyText', () => {
  it('wraps a bare https URL in an anchor tag', () => {
    const result = linkifyText('Visit https://example.com please');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer"');
    expect(result).toContain('Visit ');
    expect(result).toContain(' please');
  });

  it('wraps a bare http URL', () => {
    const result = linkifyText('http://example.com');
    expect(result).toContain('<a href="http://example.com"');
  });

  it('escapes HTML before linking so user text cannot inject markup', () => {
    const result = linkifyText('<script>alert(1)</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('passes through plain text unchanged (modulo entity escaping)', () => {
    const result = linkifyText('Hello world');
    expect(result).toBe('Hello world');
  });

  it('handles text with no URLs', () => {
    const result = linkifyText('No links here.');
    expect(result).toBe('No links here.');
  });

  it('handles multiple URLs in one message', () => {
    const result = linkifyText('See https://a.com and https://b.com');
    expect(result).toContain('<a href="https://a.com"');
    expect(result).toContain('<a href="https://b.com"');
  });

  it('does not linkify javascript: URIs', () => {
    const result = linkifyText('javascript:alert(1)');
    expect(result).not.toContain('<a href="javascript:');
  });

  it('strips trailing punctuation from linked URLs', () => {
    const result = linkifyText('Visit https://example.com. for more');
    expect(result).toContain('<a href="https://example.com"');
    expect(result).not.toContain('<a href="https://example.com."');
  });

  it('preserves balanced parentheses inside URLs', () => {
    const result = linkifyText('See https://en.wikipedia.org/wiki/Function_(mathematics) here');
    expect(result).toContain('<a href="https://en.wikipedia.org/wiki/Function_(mathematics)"');
  });
});

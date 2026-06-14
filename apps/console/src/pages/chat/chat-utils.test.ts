import { describe, it, expect } from 'vitest';
import { parseSseEvent, makeMessage, formatTimestamp, linkifyText } from './chat-utils.js';

describe('parseSseEvent', () => {
  it('returns status text for skill.invoke events', () => {
    const data = JSON.stringify({
      type: 'skill.invoke',
      skill: 'memory.recall',
      agent: 'coordinator',
      conversation_id: 'c1',
      timestamp: '2026-05-29T00:00:00Z',
    });
    expect(parseSseEvent(data)).toBe('invoking memory.recall');
  });

  it('falls back to "skill" when the skill field is absent', () => {
    const data = JSON.stringify({ type: 'skill.invoke', conversation_id: 'c1' });
    expect(parseSseEvent(data)).toBe('invoking skill');
  });

  it('returns null for skill.result events (not displayed)', () => {
    const data = JSON.stringify({ type: 'skill.result', skill: 'memory.recall' });
    expect(parseSseEvent(data)).toBeNull();
  });

  it('returns null for message events (handled via POST response)', () => {
    const data = JSON.stringify({ type: 'message', content: 'Hello' });
    expect(parseSseEvent(data)).toBeNull();
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
});

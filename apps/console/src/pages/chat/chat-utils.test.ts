import { describe, it, expect } from 'vitest';
import { parseSseEvent } from './chat-utils.js';

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

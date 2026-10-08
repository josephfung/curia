import { describe, it, expect } from 'vitest';
import { IdentifierSourceIndex } from '../../../src/agents/identifier-source-index.js';

describe('IdentifierSourceIndex', () => {
  it('finds a key recorded in the same conversation only', () => {
    const index = new IdentifierSourceIndex();
    index.record('conv-a', 'Bookings: events@venue.example');
    expect(index.has('conv-a', 'email:events@venue.example')).toBe(true);
    expect(index.has('conv-b', 'email:events@venue.example')).toBe(false);
    expect(index.has('conv-a', 'email:event@venue.example')).toBe(false);
  });

  it('forgets a key after its TTL', () => {
    let now = 0;
    const index = new IdentifierSourceIndex({ ttlMs: 1000, now: () => now });
    index.record('conv-a', 'events@venue.example');
    now = 999;
    expect(index.has('conv-a', 'email:events@venue.example')).toBe(true);
    now = 1001;
    expect(index.has('conv-a', 'email:events@venue.example')).toBe(false);
  });

  it('drops conversations whose last record has expired', () => {
    let now = 0;
    const index = new IdentifierSourceIndex({ ttlMs: 1000, now: () => now });
    index.record('conv-a', 'a@one.example');
    now = 500;
    index.record('conv-b', 'b@one.example');
    now = 1200;
    index.record('conv-c', 'c@one.example');
    expect(index.size).toBe(2);
    expect(index.has('conv-b', 'email:b@one.example')).toBe(true);
  });

  it('drops the oldest keys past the per-conversation cap', () => {
    const index = new IdentifierSourceIndex({ maxKeysPerConversation: 2 });
    index.record('conv-a', 'a@one.example');
    index.record('conv-a', 'b@one.example');
    index.record('conv-a', 'c@one.example');
    expect(index.has('conv-a', 'email:a@one.example')).toBe(false);
    expect(index.has('conv-a', 'email:b@one.example')).toBe(true);
    expect(index.has('conv-a', 'email:c@one.example')).toBe(true);
  });

  it('evicts the least recently recorded conversation past the conversation cap', () => {
    const index = new IdentifierSourceIndex({ maxConversations: 2 });
    index.record('conv-a', 'a@one.example');
    index.record('conv-b', 'b@one.example');
    index.record('conv-a', 'a2@one.example');
    index.record('conv-c', 'c@one.example');
    expect(index.has('conv-b', 'email:b@one.example')).toBe(false);
    expect(index.has('conv-a', 'email:a@one.example')).toBe(true);
    expect(index.has('conv-c', 'email:c@one.example')).toBe(true);
  });
});

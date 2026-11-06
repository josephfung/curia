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

  describe('agent input (#2498)', () => {
    it('leaves out keys the agent supplied when the result is from an echo-prone tool', () => {
      const index = new IdentifierSourceIndex();
      index.recordAgentInput('conv-a', 'https://search.example/?q=evnts@venue.example');
      index.record('conv-a', 'Results for evnts@venue.example; write events@venue.example', { excludeAgentInputOf: ['conv-a'] });
      expect(index.has('conv-a', 'email:evnts@venue.example')).toBe(false);
      expect(index.has('conv-a', 'email:events@venue.example')).toBe(true);
    });

    it('keeps them for other sources, and agent input is never a source itself', () => {
      const index = new IdentifierSourceIndex();
      index.recordAgentInput('conv-a', 'sam@venue.example');
      expect(index.has('conv-a', 'email:sam@venue.example')).toBe(false);
      index.record('conv-a', 'From: sam@venue.example');
      expect(index.has('conv-a', 'email:sam@venue.example')).toBe(true);
    });

    it('keeps a key sourced before the agent typed it', () => {
      const index = new IdentifierSourceIndex();
      index.record('conv-a', 'events@venue.example', { excludeAgentInputOf: ['conv-a'] });
      index.recordAgentInput('conv-a', 'events@venue.example');
      expect(index.has('conv-a', 'email:events@venue.example')).toBe(true);
    });

    it('scopes agent input to its conversation', () => {
      const index = new IdentifierSourceIndex();
      index.recordAgentInput('conv-a', 'evnts@venue.example');
      index.record('conv-b', 'evnts@venue.example', { excludeAgentInputOf: ['conv-b'] });
      expect(index.has('conv-b', 'email:evnts@venue.example')).toBe(true);
    });

    it('excludes agent input from every scope named, such as a browser session', () => {
      const index = new IdentifierSourceIndex();
      index.recordAgentInput('browser-session:s1', 'jon@acme.example');
      index.record('conv-b', 'Confirmation sent to jon@acme.example', { excludeAgentInputOf: ['conv-b', 'browser-session:s1'] });
      expect(index.has('conv-b', 'email:jon@acme.example')).toBe(false);
    });

    it('keeps only email and phone keys from agent input', () => {
      const index = new IdentifierSourceIndex();
      index.recordAgentInput('conv-a', '[g5f0e1] code 482913 sam@venue.example +1 416 555 0100');
      index.record('conv-a', 'U0123ABCD 482913 g5f0e1 sam@venue.example +1 416 555 0100', { excludeAgentInputOf: ['conv-a'] });
      expect(index.has('conv-a', 'token:482913')).toBe(true);
      expect(index.has('conv-a', 'email:sam@venue.example')).toBe(false);
      expect(index.has('conv-a', 'phone:+14165550100')).toBe(false);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  isExternalContactOriginator,
  shouldSkipCheckpointKgExtraction,
  resolveChannelTrust,
} from '../../../src/checkpoint/trust-gate.js';
import type { TaskOriginator } from '../../../src/contacts/types.js';

describe('isExternalContactOriginator', () => {
  it('returns false for principal, system, and agent lineage', () => {
    for (const systemRole of ['principal', 'system', 'agent'] as const) {
      expect(isExternalContactOriginator({
        contactId: 'x', systemRole, channel: 'email', initiatedAt: '', tier: null,
      })).toBe(false);
    }
  });

  it('returns true for external contacts with or without a systemRole', () => {
    expect(isExternalContactOriginator({
      contactId: 'c1', systemRole: null, channel: 'email', initiatedAt: '', tier: 'unknown',
    })).toBe(true);
    expect(isExternalContactOriginator({
      contactId: 'c2', channel: 'email', initiatedAt: '', tier: 'known',
    } as TaskOriginator)).toBe(true);
  });
});

describe('shouldSkipCheckpointKgExtraction', () => {
  it('skips unknown-tier external originators on low-trust channels', () => {
    expect(shouldSkipCheckpointKgExtraction('low', 'unknown')).toBe(true);
  });

  it('skips blocked-tier external originators on low-trust channels', () => {
    expect(shouldSkipCheckpointKgExtraction('low', 'blocked')).toBe(true);
  });

  it('fails closed when external originator has no resolved tier', () => {
    expect(shouldSkipCheckpointKgExtraction('low', null)).toBe(true);
  });

  it('allows known and trusted external originators on low-trust channels', () => {
    expect(shouldSkipCheckpointKgExtraction('low', 'known')).toBe(false);
    expect(shouldSkipCheckpointKgExtraction('low', 'trusted')).toBe(false);
  });

  it('allows conversations with no external originator (principal/system only)', () => {
    expect(shouldSkipCheckpointKgExtraction('low', 'none')).toBe(false);
  });

  it('does not skip unknown senders on high-trust channels (phase 1 scope)', () => {
    expect(shouldSkipCheckpointKgExtraction('high', 'unknown')).toBe(false);
    expect(shouldSkipCheckpointKgExtraction('medium', 'unknown')).toBe(false);
  });
});

describe('resolveChannelTrust', () => {
  it('defaults to low when channel is absent from policies', () => {
    expect(resolveChannelTrust('email')).toBe('low');
  });

  it('reads trust from channel policies when present', () => {
    expect(resolveChannelTrust('signal', {
      signal: { trust: 'high', unknownSender: 'allow', threaded: false },
    })).toBe('high');
  });
});

// live-turn-grants.test.ts — voice live-turn grants (#2495).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  activeLiveTurnGrantCountForTests,
  isLiveTurnGrantActive,
  issueLiveTurnGrant,
  lapsedLiveTurnGrantId,
  resetLiveTurnGrantsForTests,
  revokeLiveTurnGrantsForVoiceSession,
} from '../../../src/autonomy/live-turn-grants.js';

describe('live-turn grants', () => {
  beforeEach(() => {
    resetLiveTurnGrantsForTests();
  });

  it('is active until revoked, and revoking twice is harmless', () => {
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    expect(isLiveTurnGrantActive(grant.id)).toBe(true);
    grant.revoke();
    grant.revoke();
    expect(isLiveTurnGrantActive(grant.id)).toBe(false);
  });

  it('lapses at its TTL without a revoke', () => {
    let now = 1_000;
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 500, now: () => now });
    expect(isLiveTurnGrantActive(grant.id, () => now)).toBe(true);
    now = 1_500;
    expect(isLiveTurnGrantActive(grant.id, () => now)).toBe(false);
    expect(activeLiveTurnGrantCountForTests()).toBe(0);
  });

  it('ends every grant of a voice session when the call ends, and only those', () => {
    const a = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    const b = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    const other = issueLiveTurnGrant({ voiceSessionId: 's2', ttlMs: 60_000 });
    expect(revokeLiveTurnGrantsForVoiceSession('s1')).toBe(2);
    expect(isLiveTurnGrantActive(a.id)).toBe(false);
    expect(isLiveTurnGrantActive(b.id)).toBe(false);
    expect(isLiveTurnGrantActive(other.id)).toBe(true);
  });

  it('never treats a lapsed id, an unknown id or no id as active', () => {
    expect(isLiveTurnGrantActive(lapsedLiveTurnGrantId())).toBe(false);
    expect(isLiveTurnGrantActive('ltg-made-up')).toBe(false);
    expect(isLiveTurnGrantActive(undefined)).toBe(false);
  });

  it('keeps one registry per process, so a second copy of the module sees the same grants', async () => {
    const grant = issueLiveTurnGrant({ voiceSessionId: 's1', ttlMs: 60_000 });
    vi.resetModules();
    const copy = await import('../../../src/autonomy/live-turn-grants.js');
    expect(copy.isLiveTurnGrantActive(grant.id)).toBe(true);
    expect(copy.revokeLiveTurnGrantsForVoiceSession('s1')).toBe(1);
    expect(isLiveTurnGrantActive(grant.id)).toBe(false);
  });
});

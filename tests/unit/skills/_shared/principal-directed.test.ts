import { describe, it, expect } from 'vitest';
import { isPrincipalDirectedSend } from '../../../../src/skills/_shared/principal-directed.js';

function originator(systemRole: 'principal' | 'agent' | 'system' | null) {
  return { originator: { contactId: 'c1', systemRole, channel: 'signal', initiatedAt: '2026-09-17T14:00:00Z', tier: null } };
}

describe('isPrincipalDirectedSend (#1870)', () => {
  it('is true for a live principal turn', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: originator('principal'), liveTurn: true })).toBe(true);
  });

  it('is true when the principal approved the exact action', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: undefined, humanApproved: true })).toBe(true);
  });

  it('is false for principal lineage without a live turn (woken or scheduled task)', () => {
    // A heartbeat wake can keep principal standing through the bypass ladder, but its
    // content is composed autonomously, so it must not skip the disclosure gate.
    expect(isPrincipalDirectedSend({ taskMetadata: originator('principal') })).toBe(false);
    expect(isPrincipalDirectedSend({ taskMetadata: originator('principal'), liveTurn: false })).toBe(false);
  });

  it('is false for a live-turn flag without principal lineage (defence in depth)', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: originator('agent'), liveTurn: true })).toBe(false);
  });

  it.each(['agent', 'system', null] as const)('is false for a %s-originated task', (role) => {
    expect(isPrincipalDirectedSend({ taskMetadata: originator(role) })).toBe(false);
  });

  it('is false with no task metadata (fail-closed default)', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: undefined })).toBe(false);
  });
});

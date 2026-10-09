import { describe, it, expect } from 'vitest';
import { isPrincipalDirectedSend } from '../../../../src/skills/_shared/principal-directed.js';

function originator(systemRole: 'principal' | 'agent' | 'system' | null) {
  return { originator: { contactId: 'c1', systemRole, channel: 'signal', initiatedAt: '2026-09-17T14:00:00Z', tier: null } };
}

describe('isPrincipalDirectedSend (#1870)', () => {
  it('is true for a principal-originated task', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: originator('principal') })).toBe(true);
  });

  it('is true when the principal approved the exact action', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: undefined, humanApproved: true })).toBe(true);
  });

  it.each(['agent', 'system', null] as const)('is false for a %s-originated task', (role) => {
    expect(isPrincipalDirectedSend({ taskMetadata: originator(role) })).toBe(false);
  });

  it('is false with no task metadata (fail-closed default)', () => {
    expect(isPrincipalDirectedSend({ taskMetadata: undefined })).toBe(false);
  });
});

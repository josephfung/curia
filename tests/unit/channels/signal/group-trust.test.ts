import { describe, it, expect, vi } from 'vitest';
import { checkGroupMemberTrust } from '../../../../src/channels/signal/group-trust.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';

/**
 * Build a ContactService mock that returns the provided contact record
 * for the given phone numbers, and null for any other identifier.
 */
function makeContactService(
  responses: Record<string, { contactId: string; status: 'confirmed' | 'provisional' | 'blocked' } | null>,
): ContactService {
  return {
    resolveByChannelIdentity: vi.fn().mockImplementation(
      (_channel: string, identifier: string) =>
        Promise.resolve(responses[identifier] ?? null),
    ),
  } as unknown as ContactService;
}

describe('checkGroupMemberTrust', () => {
  it('returns trusted:true when all members are verified contacts', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'confirmed' },
      '+14165559999': { contactId: 'c2', status: 'confirmed' },
    });

    const result = await checkGroupMemberTrust(['+14155551234', '+14165559999'], svc);

    expect(result).toEqual({ trusted: true, unknownMembers: [], blockedMembers: [] });
  });

  it('surfaces a provisional contact as unknownMember', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'provisional' },
    });

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual([]);
  });

  it('surfaces a null contact (no record) as unknownMember', async () => {
    const svc = makeContactService({}); // all lookups return null

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual([]);
  });

  it('surfaces a blocked contact as blockedMember', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'blocked' },
    });

    const result = await checkGroupMemberTrust(['+14155551234'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual([]);
    expect(result.blockedMembers).toEqual(['+14155551234']);
  });

  it('surfaces both unknown and blocked members in a mixed group', async () => {
    const svc = makeContactService({
      '+14155551234': { contactId: 'c1', status: 'provisional' },
      '+14165559999': { contactId: 'c2', status: 'blocked' },
    });

    const result = await checkGroupMemberTrust(['+14155551234', '+14165559999'], svc);

    expect(result.trusted).toBe(false);
    expect(result.unknownMembers).toEqual(['+14155551234']);
    expect(result.blockedMembers).toEqual(['+14165559999']);
  });

  it('returns trusted:true for an empty member list (edge case: empty group)', async () => {
    const svc = makeContactService({});

    const result = await checkGroupMemberTrust([], svc);

    expect(result).toEqual({ trusted: true, unknownMembers: [], blockedMembers: [] });
  });
});

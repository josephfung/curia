import { describe, expect, it } from 'vitest';
import {
  invitationSummary,
  readInvitationBody,
  shouldPollInvitation,
  type InvitationStatus,
} from './invitation-state.js';

const waiting: InvitationStatus = {
  id: 'inv-1',
  state: 'waiting',
  expiresAt: '2026-11-04T12:00:00.000Z',
  redeemedAt: null,
  deviceName: null,
};

describe('readInvitationBody', () => {
  it('reads the current link, no link, and rejects a malformed body', () => {
    expect(readInvitationBody({ invitation: waiting })).toEqual(waiting);
    expect(readInvitationBody({ invitation: null })).toBeNull();
    expect(readInvitationBody({ invitation: { ...waiting, state: 'superseded' } })).toBeUndefined();
    expect(readInvitationBody({})).toBeUndefined();
    expect(readInvitationBody(null)).toBeUndefined();
  });
});

describe('invitationSummary', () => {
  const before = Date.parse('2026-11-03T12:00:00.000Z');

  it('says a live link is waiting, with its expiry', () => {
    expect(invitationSummary(waiting, before)).toMatch(/^Waiting to be opened · expires /);
  });

  it('names the device on a redeemed link', () => {
    const redeemed = { ...waiting, state: 'redeemed' as const, redeemedAt: '2026-11-03T13:00:00.000Z', deviceName: 'iPhone · Safari' };
    expect(invitationSummary(redeemed, before)).toMatch(/^Redeemed ✓ · iPhone · Safari · /);
  });

  it('reads as expired once the clock passes, before the server says so', () => {
    const after = Date.parse('2026-11-04T12:00:01.000Z');
    expect(invitationSummary(waiting, after)).toMatch(/^Expired /);
    expect(invitationSummary({ ...waiting, state: 'expired' }, before)).toMatch(/^Expired /);
  });
});

describe('shouldPollInvitation', () => {
  it('polls only a waiting link', () => {
    expect(shouldPollInvitation(waiting)).toBe(true);
    expect(shouldPollInvitation({ ...waiting, state: 'redeemed' })).toBe(false);
    expect(shouldPollInvitation({ ...waiting, state: 'expired' })).toBe(false);
    expect(shouldPollInvitation(null)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { shouldStopPairingPoll } from './pairing-poll.js';

const open = {
  tokenRedeemed: false,
  shortRedeemed: false,
  expired: false,
  tokenDeviceName: null,
  shortDeviceName: null,
};

describe('shouldStopPairingPoll', () => {
  it('stops on 404, expiry, or both credentials, and keeps waiting otherwise', () => {
    expect(shouldStopPairingPoll(404, null)).toBe(true);
    expect(shouldStopPairingPoll(200, { ...open, expired: true })).toBe(true);
    expect(shouldStopPairingPoll(200, { ...open, tokenRedeemed: true, shortRedeemed: true })).toBe(true);
    expect(shouldStopPairingPoll(200, { ...open, tokenRedeemed: true })).toBe(false);
    expect(shouldStopPairingPoll(200, open)).toBe(false);
    expect(shouldStopPairingPoll(503, null)).toBe(false);
  });
});

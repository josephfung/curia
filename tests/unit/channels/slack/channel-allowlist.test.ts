import { describe, it, expect } from 'vitest';
import { isSlackChannelAllowed } from '../../../../src/channels/slack/channel-allowlist.js';

describe('isSlackChannelAllowed', () => {
  it('allows all channels when allowlist is empty or undefined', () => {
    expect(isSlackChannelAllowed('C1', undefined)).toBe(true);
    expect(isSlackChannelAllowed('C1', [])).toBe(true);
  });

  it('allows only listed channel ids', () => {
    expect(isSlackChannelAllowed('C1', ['C1', 'C2'])).toBe(true);
    expect(isSlackChannelAllowed('C9', ['C1', 'C2'])).toBe(false);
  });
});

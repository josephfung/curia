import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { loadAuthConfig } from './config-loader.js';
import { isBlockedSender, unknownSenderPolicy } from './channel-sender-policy.js';
import type { ChannelPolicyConfig, InboundSenderContext, SenderContext } from './types.js';

const CONFIG_DIR = path.resolve(import.meta.dirname, '../../config');

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function resolvedSender(tier: SenderContext['tier']): SenderContext {
  return {
    resolved: true,
    contactId: PARTNER_ID,
    displayName: 'Alex Partner',
    role: 'partner',
    systemRole: null,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.9,
    tier,
    kind: 'person',
  };
}

describe('unknownSenderPolicy', () => {
  it('reads voice and signal from channel-trust.yaml via loadAuthConfig', () => {
    const { channelPolicies } = loadAuthConfig(CONFIG_DIR);
    expect(unknownSenderPolicy(channelPolicies, 'voice')).toBe('ignore');
    expect(unknownSenderPolicy(channelPolicies, 'signal')).toBe('allow');
  });

  it('is ignore only when that channel is explicitly ignore', () => {
    const policies: Record<string, ChannelPolicyConfig> = {
      voice: { trust: 'high', unknownSender: 'allow', threaded: false },
      signal: { trust: 'high', unknownSender: 'ignore', threaded: false },
    };
    expect(unknownSenderPolicy(policies, 'voice')).toBe('allow');
    expect(unknownSenderPolicy(policies, 'signal')).toBe('ignore');
  });

  it('defaults to allow when the map, channel, or policy is missing', () => {
    expect(unknownSenderPolicy(undefined, 'voice')).toBe('allow');
    expect(unknownSenderPolicy({}, 'voice')).toBe('allow');
    expect(unknownSenderPolicy(
      { http: { trust: 'medium', unknownSender: 'ignore', threaded: false } },
      'voice',
    )).toBe('allow');
  });
});

describe('isBlockedSender', () => {
  it('is true only for a resolved blocked-tier contact', () => {
    expect(isBlockedSender(resolvedSender('blocked'))).toBe(true);
    expect(isBlockedSender(resolvedSender('trusted'))).toBe(false);
  });

  it('is false for an unresolved sender', () => {
    const unknown: InboundSenderContext = {
      resolved: false,
      channel: 'voice',
      senderId: 'unknown-token',
    };
    expect(isBlockedSender(unknown)).toBe(false);
  });
});

// channel-sender-policy.ts — shared unknown-sender / blocked lookup.
//
// Dispatcher, the voice token seam, and Signal voice calls all consult the same
// loadAuthConfig() → channelPolicies map. Keep the lookup here so voice cannot
// grow an independent default (#1626).

import type {
  ChannelPolicyConfig,
  InboundSenderContext,
  UnknownSenderPolicy,
} from './types.js';

/**
 * Resolve a channel's unknown_sender policy from the map the dispatcher uses.
 *
 * `'ignore'` only when that channel's loaded policy is `'ignore'`. Missing map,
 * missing channel, or any other value → `'allow'` (same as dispatcher.ts).
 */
export function unknownSenderPolicy(
  channelPolicies: Record<string, ChannelPolicyConfig> | undefined,
  channel: string,
): UnknownSenderPolicy {
  return channelPolicies?.[channel]?.unknownSender === 'ignore' ? 'ignore' : 'allow';
}

/**
 * True when the resolver found a contact the operator has explicitly blocked.
 * Not a YAML field — always deny, matching the dispatcher blocked-sender gate.
 */
export function isBlockedSender(senderContext: InboundSenderContext): boolean {
  return senderContext.resolved && senderContext.tier === 'blocked';
}

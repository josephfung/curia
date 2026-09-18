// channel-sender-policy.ts — shared unknown-sender / blocked lookup.
//
// Dispatcher, the voice token seam, and Signal voice calls all consult the same
// loadAuthConfig() → channelPolicies map. Keep the lookup here so voice cannot
// grow an independent default (#1626).

import {
  isAutomatedKind,
  type ChannelPolicyConfig,
  type InboundSenderContext,
  type UnknownSenderPolicy,
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

/**
 * True when this sender should be dropped under the channel's unknown_sender
 * `ignore` policy — the same predicate the dispatcher uses:
 * unresolved senders, and resolved `tier: 'unknown'` contacts that are not
 * automated (automated's normal starting state is unknown).
 *
 * Returns false when the channel policy is `allow` (or the key is absent —
 * dispatcher default). Blocked contacts are a separate always-deny gate.
 */
export function isUnknownSenderIgnored(
  senderContext: InboundSenderContext,
  channelPolicies: Record<string, ChannelPolicyConfig> | undefined,
  channel: string,
): boolean {
  if (unknownSenderPolicy(channelPolicies, channel) !== 'ignore') return false;
  if (!senderContext.resolved) return true;
  return senderContext.tier === 'unknown' && !isAutomatedKind(senderContext.kind);
}

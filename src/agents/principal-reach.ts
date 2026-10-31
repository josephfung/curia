// Which channels an agent may use to reach the principal (#2341, ADR-046).
//
// The block is injected only for an agent that has a send skill, and it names
// only channels that are actually configured. The phone app is included only
// while a device is subscribed or a browser is watching the thread. A standing
// preference that names a channel is stated first and overrides the default order.

export const REACH_CHANNELS = ['signal', 'sms', 'web', 'slack', 'email'] as const;
export type ReachChannel = (typeof REACH_CHANNELS)[number];

export const FALLBACK_CHANNELS = ['signal', 'sms', 'slack', 'email'] as const;
export type FallbackChannel = (typeof FALLBACK_CHANNELS)[number];

const SEND_TOOLS: Record<ReachChannel, readonly string[]> = {
  signal: ['signal-send'],
  sms: ['sms-send'],
  web: ['web-send'],
  slack: ['slack-send'],
  email: ['email-send', 'email-reply'],
};

const LABEL: Record<ReachChannel, string> = {
  signal: 'Signal',
  sms: 'SMS',
  web: 'the phone app (`web-send` with recipient "principal")',
  slack: 'Slack',
  email: 'email',
};

export interface PrincipalReach {
  channels: readonly ReachChannel[];
  /** A standing preference that names how to reach them. It overrides `channels`. */
  preference: string | null;
}

export function agentCanSend(pinnedTools: readonly string[]): boolean {
  return REACH_CHANNELS.some((channel) =>
    SEND_TOOLS[channel].some((tool) => pinnedTools.includes(tool)),
  );
}

/** Channels this agent can send on, in the default order, limited to those configured. */
export function reachChannelsFor(
  pinnedTools: readonly string[],
  configured: ReadonlySet<ReachChannel>,
): ReachChannel[] {
  return REACH_CHANNELS.filter((channel) =>
    configured.has(channel) && SEND_TOOLS[channel].some((tool) => pinnedTools.includes(tool)),
  );
}

/**
 * The standing preference that tells agents which channel to use when something
 * needs the principal now. Other preferences (tone, length) are not a channel order.
 */
export function urgentPreference(preferences: readonly string[]): string | null {
  for (const pref of preferences) {
    const text = pref.trim();
    if (!text) continue;
    if (/\b(signal|sms|slack|email|phone)\b/i.test(text) && /\b(right away|one channel|urgent|use)\b/i.test(text)) {
      return text;
    }
  }
  return null;
}

export function formatPrincipalReachBlock(reach: PrincipalReach): string | null {
  if (reach.channels.length === 0) return null;
  const order = reach.channels.map((channel) => LABEL[channel]).join(', then ');
  const lines = ['## Reaching the principal'];
  if (reach.preference) {
    lines.push(`Their standing preference overrides the default order: ${reach.preference}`);
    lines.push(`When they have not named a channel and that preference does not apply, reach them in this order: ${order}.`);
    lines.push('An explicit request also overrides both.');
  } else {
    lines.push(`When they have not named a channel, reach them in this order: ${order}.`);
    lines.push('Their standing preferences and an explicit request override this order.');
  }
  lines.push('If the phone could not take the message, the tool names the channel it already used. Do not send the message again.');
  return lines.join('\n');
}

/** Configured fallback channels, with any channel a standing preference names moved first. */
export function orderFallbackChannels(
  configured: readonly FallbackChannel[],
  preference: string | null,
): FallbackChannel[] {
  const available = new Set(configured);
  const present = FALLBACK_CHANNELS.filter((channel) => available.has(channel));
  if (!preference) return present;
  const lower = preference.toLowerCase();
  const named = present
    .filter((channel) => lower.includes(channel))
    .sort((a, b) => lower.indexOf(a) - lower.indexOf(b));
  const rest = present.filter((channel) => !named.includes(channel));
  return [...named, ...rest];
}

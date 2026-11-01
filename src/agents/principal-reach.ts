// Which channels an agent may use to reach the principal (#2341, ADR-046).
//
// The block is injected only for an agent that has a send skill, and it names
// only channels that are actually configured and that the principal can be
// reached on. The phone app is included only while a device is subscribed or
// a browser is watching the thread. Standing preferences already reach the
// agent through the identity block, so this block does not parse them.

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

export function formatPrincipalReachBlock(reach: PrincipalReach): string | null {
  if (reach.channels.length === 0) return null;
  const order = reach.channels.map((channel) => LABEL[channel]).join(', then ');
  const lines = [
    '## Reaching the principal',
    `When they have not named a channel, reach them in this order: ${order}.`,
    'Their standing preferences and an explicit request override this order.',
    'If the phone could not take the message, the tool names the channel it already used. Do not send the message again.',
  ];
  return lines.join('\n');
}

/** Configured fallback channels, in the default order. Preferences are not parsed. */
export function orderFallbackChannels(configured: readonly FallbackChannel[]): FallbackChannel[] {
  const available = new Set(configured);
  return FALLBACK_CHANNELS.filter((channel) => available.has(channel));
}

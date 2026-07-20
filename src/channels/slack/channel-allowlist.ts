// src/channels/slack/channel-allowlist.ts
// Optional allowlist for Slack @mentions (ADR-033). DMs are never filtered here.

/**
 * Returns true when the mention should be accepted.
 * Empty/undefined allowlist → accept all channels the bot is in.
 */
export function isSlackChannelAllowed(
  slackChannelId: string,
  allowedChannelIds: readonly string[] | undefined,
): boolean {
  if (!allowedChannelIds || allowedChannelIds.length === 0) return true;
  return allowedChannelIds.includes(slackChannelId);
}

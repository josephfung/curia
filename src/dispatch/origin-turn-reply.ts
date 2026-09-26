// origin-turn-reply.ts — one principal reply while a delegation is still open (#1917).
//
// A specialist that actions a delegation and narrates it in the bullpen wakes the
// delegator (BullpenDispatcher propagates originator, so the wake can reach a human
// channel) while the originating turn is still going to answer. Reference trace:
// audit_log seq 1064595-1064698. The stamp below is how the wake learns that.
// Originator propagation and the liveTurn exclusion (#1126) are unchanged.
//
// The stamp suppresses a duplicate, not the channel. A bullpen wake with no open
// delegation — genuinely new information — carries no stamp and may still send.

/** Metadata key on the bullpen-woken agent.task. Absent when no delegation is open. */
export const ORIGIN_TURN_OWNS_REPLY_KEY = 'originTurnOwnsReply';

/** The running delegation whose originating turn will answer the principal. */
export interface OriginTurnOwnsReply {
  delegateEventId: string;
  originConversationId: string;
  originChannelId: string;
}

/** One running delegation, named by the agent whose turn is still open. */
export interface RunningOriginTurnHit extends OriginTurnOwnsReply {
  originAgentId: string;
}

/**
 * Human-channel sends the originating turn already owns.
 * `send-draft` is included because a draft send is still a delivery.
 * Bullpen replies and other internal skills are not in this set.
 */
const HUMAN_REPLY_SKILLS: ReadonlySet<string> = new Set([
  'email-reply',
  'email-send',
  'send-draft',
  'signal-send',
  'sms-send',
  'slack-send',
]);

export function isHumanReplySkill(toolName: string): boolean {
  return HUMAN_REPLY_SKILLS.has(toolName);
}

/**
 * Agent-facing refusal. Names the outcome (not delivered) and where the real
 * reply will land, without repeating the originating address — that string is
 * often the principal's phone number, and echoing it invites a retry.
 */
export const ORIGIN_TURN_OWNS_REPLY_ERROR =
  'Not sent. The turn that delegated this work is still open and will answer the principal on the originating conversation. Do not send another confirmation. Reply on the bullpen thread if other agents need something.';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Accept only a complete stamp. Anything else fails open: a malformed bag must
 * not throw the send path, and it must not suppress a real message.
 */
export function parseOriginTurnOwnsReply(value: unknown): OriginTurnOwnsReply | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const delegateEventId = record['delegateEventId'];
  const originConversationId = record['originConversationId'];
  const originChannelId = record['originChannelId'];
  if (!nonEmptyString(delegateEventId)) return null;
  if (!nonEmptyString(originConversationId)) return null;
  if (!nonEmptyString(originChannelId)) return null;
  return { delegateEventId, originConversationId, originChannelId };
}

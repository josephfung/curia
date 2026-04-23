// src/channels/signal/message-converter.ts
//
// Converts a signal-cli SignalEnvelope into a normalized ConvertedSignalMessage
// that the SignalAdapter can publish to the bus as an inbound.message event.
//
// Many envelope types arrive that we don't want to process as messages:
//   - syncMessage: the agent sent this from another device — not inbound
//   - reaction: emoji reaction to a prior message — ignored per spec (MVP)
//   - viewOnce: self-destructing message — skip (we don't want LLM context on ephemeral content)
//   - null/empty message: attachment-only or other non-text envelope
//   - group management events (UPDATE/QUIT): not displayable content
// All ignored cases return null so the adapter can skip them cleanly.

import type { SignalEnvelope, SignalAttachment } from './types.js';

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ConvertedSignalMessage {
  conversationId: string;
  channelId: 'signal';
  /** E.164 sender phone number — used as the bus senderId */
  senderId: string;
  content: string;
  metadata: {
    /** Sender's Signal display name (may be empty string if not set) */
    sourceName: string;
    /**
     * Signal-level timestamp in milliseconds. This is NOT a wall-clock time —
     * it's the identifier Signal uses internally. Required for sending read receipts:
     * the sendReceipt RPC call must supply the exact targetTimestamp from this field.
     */
    signalTimestamp: number;
    /** Set when this was a group message. Needed to route outbound replies to the group. */
    groupId?: string;
    /** True when the message arrived in a group chat */
    isGroup: boolean;
    attachments?: SignalAttachment[];
  };
}

// ---------------------------------------------------------------------------
// Converter
// ---------------------------------------------------------------------------

/**
 * Convert a signal-cli envelope to a normalized message shape.
 *
 * Returns null for any envelope that should be silently ignored:
 *   - syncMessage (self-sent from another device)
 *   - reaction (emoji reaction — no text content)
 *   - viewOnce (ephemeral content)
 *   - no dataMessage
 *   - null or empty message text
 *   - group management events (type !== 'DELIVER')
 */
export function convertSignalEnvelope(
  envelope: SignalEnvelope,
): ConvertedSignalMessage | null {
  // Sync messages are the agent's outbound activity mirrored back to linked devices.
  // We never want these to appear as inbound requests to the coordinator.
  if (envelope.syncMessage) return null;

  // Must have a dataMessage to have any content worth processing.
  const data = envelope.dataMessage;
  if (!data) return null;

  // View-once messages are designed to be ephemeral — skip them entirely rather
  // than storing their content in working memory or the audit log.
  if (data.viewOnce) return null;

  // Reactions don't carry actionable text content — ignored for MVP per spec.
  // A future version could acknowledge reactions or use them as signals (e.g.,
  // thumbs-up = approve pending action), but that's out of scope for the first pass.
  if (data.reaction) return null;

  // Skip group management events (someone added/left the group, group name changed, etc.)
  // Only DELIVER means a real message was sent to the group.
  const groupInfo = data.groupInfo;
  if (groupInfo && groupInfo.type !== 'DELIVER') return null;

  // Empty or whitespace-only messages have no content worth routing to the LLM.
  const rawContent = data.message?.trim() ?? '';
  if (!rawContent) return null;

  // Build conversation ID.
  // Group: signal:group=<base64GroupId>  — stable across all members
  // 1:1:   signal:<E.164 number>         — the sender's phone number
  // The `group=` prefix prevents collisions between a group ID that happens to
  // look like a phone number and an actual 1:1 conversation.
  //
  // Guard: if groupInfo is present but groupId is empty, we cannot form a valid
  // conversation ID and must skip the message. This should never happen in practice
  // (signal-cli always sets groupId for group messages), but be defensive.
  if (groupInfo && !groupInfo.groupId) return null;

  const isGroup = !!groupInfo;
  const conversationId = isGroup
    ? `signal:group=${groupInfo.groupId}`
    : `signal:${envelope.sourceNumber}`;

  return {
    conversationId,
    channelId: 'signal',
    senderId: envelope.sourceNumber,
    content: rawContent,
    metadata: {
      sourceName: envelope.sourceName,
      signalTimestamp: envelope.timestamp,
      groupId: groupInfo?.groupId,
      isGroup,
      attachments: data.attachments?.length ? data.attachments : undefined,
    },
  };
}

// src/channels/signal/message-converter.ts
//
// Converts a signal-cli SignalEnvelope into a normalized ConvertedSignalMessage
// that the SignalAdapter can publish to the bus as an inbound.message event.
//
// Many envelope types arrive that we don't want to process as messages:
//   - syncMessage: the agent sent this from another device — not inbound
//   - reaction: handled separately via convertSignalReaction → inbound.reaction
//   - viewOnce: self-destructing message — skip (we don't want LLM context on ephemeral content)
//   - null/empty message: attachment-only or other non-text envelope
//     (audio attachments are an exception — the adapter transcribes them, #1600)
//   - group management events (UPDATE/QUIT): not displayable content
// All ignored cases return null so the adapter can skip them cleanly.

import type { SignalEnvelope, SignalAttachment } from './types.js';
import { findFirstAudioAttachment } from '../inbound-voice-note.js';

// ---------------------------------------------------------------------------
// Output types
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
    /**
     * Sender ACI (Signal UUID). Used as `getAttachment` recipient fallback when
     * `sourceNumber` is empty (username / ACI-only senders).
     */
    sourceUuid?: string;
    attachments?: SignalAttachment[];
  };
}

/**
 * Channel-agnostic reaction shape. Emoji→intent mapping lives in dispatch/approval.
 * `isRemove` is carried in metadata so the mapper can no-op un-reacts (#1479).
 */
export interface ConvertedSignalReaction {
  conversationId: string;
  channelId: 'signal';
  senderId: string;
  emoji: string;
  /** Stringified Signal targetTimestamp — correlates to outbound.delivered.messageId. */
  targetMessageId: string;
  metadata: {
    sourceName: string;
    targetAuthor: string;
    isRemove: boolean;
    signalTimestamp: number;
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
 *   - null or empty message text with no audio attachment
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

  // Reactions are normalized separately via convertSignalReaction → inbound.reaction.
  if (data.reaction) return null;

  // Skip group management events (someone added/left the group, group name changed, etc.)
  // Only DELIVER means a real message was sent to the group.
  const groupInfo = data.groupInfo;
  if (groupInfo && groupInfo.type !== 'DELIVER') return null;

  // Empty or whitespace-only messages have no content worth routing to the LLM
  // unless they carry audio (voice note) — the adapter transcribes those (#1600).
  const rawContent = data.message?.trim() ?? '';
  const hasAudio = !!findFirstAudioAttachment(data.attachments);
  if (!rawContent && !hasAudio) return null;

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
      sourceUuid: envelope.sourceUuid || undefined,
      attachments: data.attachments?.length ? data.attachments : undefined,
    },
  };
}

/**
 * Normalize a Signal reaction envelope into a channel-agnostic reaction shape.
 * Returns null for non-reaction envelopes or reactions missing required fields.
 * Does not map emoji→intent — that belongs in dispatch/approval (#1479).
 */
export function convertSignalReaction(
  envelope: SignalEnvelope,
): ConvertedSignalReaction | null {
  if (envelope.syncMessage) return null;

  const data = envelope.dataMessage;
  const reaction = data?.reaction;
  if (!reaction) return null;

  const emoji = reaction.emoji?.trim();
  if (!emoji) return null;
  if (typeof reaction.targetTimestamp !== 'number' || !Number.isFinite(reaction.targetTimestamp)) {
    return null;
  }
  if (!envelope.sourceNumber) return null;

  // Best-effort conversation key (1:1 with the reactor). Approval correlation
  // keys on targetMessageId ↔ outbound.delivered.messageId, not conversationId.
  return {
    conversationId: `signal:${envelope.sourceNumber}`,
    channelId: 'signal',
    senderId: envelope.sourceNumber,
    emoji,
    targetMessageId: String(reaction.targetTimestamp),
    metadata: {
      sourceName: envelope.sourceName,
      targetAuthor: reaction.targetAuthor,
      isRemove: Boolean(reaction.isRemove),
      signalTimestamp: envelope.timestamp,
    },
  };
}

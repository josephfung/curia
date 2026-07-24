// message-converter.ts — Telnyx webhook payload → normalized inbound SMS fields.

import type { ConvertedSmsMessage, TelnyxWebhookEnvelope } from './types.js';
import {
  SMS_HELP_KEYWORDS,
  SMS_START_KEYWORDS,
  SMS_STOP_KEYWORDS,
} from './types.js';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export function buildSmsConversationId(peerE164: string): string {
  return `sms:${peerE164}`;
}

export function parseSmsConversationId(conversationId: string): string | null {
  if (!conversationId.startsWith('sms:')) return null;
  const peer = conversationId.slice('sms:'.length);
  return E164_REGEX.test(peer) ? peer : null;
}

/** Normalize a phone string to E.164 when already well-formed; otherwise null. */
export function normalizeE164(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (E164_REGEX.test(trimmed)) return trimmed;
  return null;
}

/**
 * Classify A2P keyword commands from inbound SMS text (whole-message match).
 * Returns null when the message is ordinary content for the agent.
 */
export function classifySmsKeyword(
  text: string,
): 'stop' | 'start' | 'help' | null {
  const normalized = text.trim().toUpperCase();
  if (SMS_STOP_KEYWORDS.has(normalized)) return 'stop';
  if (SMS_START_KEYWORDS.has(normalized)) return 'start';
  if (SMS_HELP_KEYWORDS.has(normalized)) return 'help';
  return null;
}

/**
 * Convert a Telnyx Messaging webhook body into a normalized inbound message.
 *
 * Returns null when the event is not an inbound SMS we should publish
 * (wrong event type, missing from/text, non-E.164 peer, empty body).
 * MMS is accepted as text-only in v1 (media ignored).
 */
export function convertTelnyxWebhook(
  body: TelnyxWebhookEnvelope,
): ConvertedSmsMessage | null {
  const data = body.data;
  if (!data || data.event_type !== 'message.received') return null;

  const payload = data.payload;
  if (!payload) return null;

  const senderId = normalizeE164(payload.from?.phone_number);
  if (!senderId) return null;

  const text = typeof payload.text === 'string' ? payload.text : '';
  // Whitespace-only is still a message for keyword detection (STOP etc.);
  // empty string after trim with no content is ignored for agent publish —
  // keyword classifier runs on the raw text in the adapter before this matters.
  if (text.trim().length === 0) return null;

  const toNumber = normalizeE164(payload.to?.[0]?.phone_number) ?? undefined;

  return {
    conversationId: buildSmsConversationId(senderId),
    channelId: 'sms',
    senderId,
    content: text,
    metadata: {
      telnyxMessageId: payload.id,
      telnyxEventId: data.id,
      toNumber,
      direction: payload.direction,
    },
  };
}

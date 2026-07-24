// message-converter.ts — Telnyx webhook payload → normalized inbound SMS fields.

import type { ConvertedSmsMessage, TelnyxWebhookEnvelope } from './types.js';

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
 * Convert a Telnyx Messaging webhook body into a normalized inbound message.
 *
 * Returns null when the event is not an inbound SMS we should publish
 * (wrong event type, missing from/text, non-E.164 peer, empty body).
 * MMS is accepted as text-only in v1 (media ignored).
 *
 * STOP / natural-language opt-out text is published like any other message —
 * Telnyx enforces carrier STOP; Curia records preferences as contact KG facts.
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

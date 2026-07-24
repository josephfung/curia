// SMS channel wire types — Telnyx Messaging webhook + Messages API shapes we care about.

/**
 * Thin provider seam so a later Twilio (etc.) swap stays local to the client.
 * The sender DID is pinned by the client (configured office `from_number`) and is
 * deliberately NOT a caller-supplied parameter — no send path may spoof the From.
 */
export interface SmsProvider {
  sendSms(params: { to: string; text: string }): Promise<{ messageId: string }>;
}

/** Telnyx Messaging webhook envelope (API v2) — only fields we read. */
export interface TelnyxWebhookEnvelope {
  data?: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload?: TelnyxMessagePayload;
  };
}

export interface TelnyxMessagePayload {
  id?: string;
  /** "SMS" | "MMS" — v1 ignores MMS media. */
  type?: string;
  text?: string;
  from?: { phone_number?: string };
  to?: Array<{ phone_number?: string }>;
  direction?: string;
}

export interface ConvertedSmsMessage {
  conversationId: string;
  channelId: 'sms';
  /** Peer E.164 — used as bus senderId. */
  senderId: string;
  content: string;
  metadata: {
    telnyxMessageId?: string;
    telnyxEventId?: string;
    toNumber?: string;
    direction?: string;
  };
}

/**
 * Telnyx error code when the destination previously texted STOP (carrier
 * suppression). Surfaced as a clear blockedReason so the agent can record a KG
 * fact instead of retrying — Curia keeps no parallel opt-out ledger (ADR-036).
 */
export const TELNYX_ERROR_OPTED_OUT = 40300;

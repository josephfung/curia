// SMS channel wire types — Telnyx Messaging webhook + Messages API shapes we care about.

/** Thin provider seam so a later Twilio (etc.) swap stays local to the client. */
export interface SmsProvider {
  sendSms(params: { to: string; from: string; text: string }): Promise<{ messageId: string }>;
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

/** Keywords that trigger US A2P opt-out (CTIA common set). */
export const SMS_STOP_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
]);

/** Keywords that re-enable messaging after opt-out. */
export const SMS_START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);

/** HELP auto-reply trigger. */
export const SMS_HELP_KEYWORDS = new Set(['HELP', 'INFO']);

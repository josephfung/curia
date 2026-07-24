// webhook-bridge.ts — shared hook so HttpAdapter can mount the Telnyx route
// while SmsAdapter owns signature verify + inbound handling (start/stop gated).

export interface SmsWebhookHeaders {
  signature?: string;
  timestamp?: string;
}

export interface SmsWebhookResult {
  status: number;
  body?: { error?: string; ok?: boolean };
}

export type SmsWebhookHandler = (
  rawBody: Buffer,
  headers: SmsWebhookHeaders,
) => Promise<SmsWebhookResult>;

/**
 * Mutable bridge: SmsAdapter.start() installs the handler; stop() clears it.
 * When unset, the HTTP route returns 503 so Telnyx retries after enable/restart.
 */
export class SmsWebhookBridge {
  private handler: SmsWebhookHandler | null = null;

  setHandler(handler: SmsWebhookHandler | null): void {
    this.handler = handler;
  }

  getHandler(): SmsWebhookHandler | null {
    return this.handler;
  }
}

// sms-client.ts — thin Telnyx Messages API client behind SmsProvider.

import type { Logger } from '../../logger.js';
import type { SmsProvider } from './types.js';

const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';

export interface SmsClientConfig {
  apiKey: string;
  /** Office DID in E.164 — used as From on every send. */
  fromNumber: string;
  /** Account public key (base64) for webhook signature verification. */
  webhookPublicKey: string;
  logger: Logger;
  /** Override Messages API URL (tests). */
  messagesUrl?: string;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class SmsClient implements SmsProvider {
  readonly fromNumber: string;
  readonly webhookPublicKey: string;
  private readonly apiKey: string;
  private readonly log: Logger;
  private readonly messagesUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SmsClientConfig) {
    this.apiKey = config.apiKey;
    this.fromNumber = config.fromNumber;
    this.webhookPublicKey = config.webhookPublicKey;
    this.log = config.logger.child({ component: 'sms-client' });
    this.messagesUrl = config.messagesUrl ?? TELNYX_MESSAGES_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async sendSms(params: { to: string; from: string; text: string }): Promise<{ messageId: string }> {
    const res = await this.fetchImpl(this.messagesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        text: params.text,
      }),
    });

    const bodyText = await res.text();
    let parsed: { data?: { id?: string }; errors?: Array<{ detail?: string }> };
    try {
      parsed = JSON.parse(bodyText) as typeof parsed;
    } catch {
      this.log.error(
        { status: res.status, bodyLength: bodyText.length },
        'sms-client: Telnyx response was not JSON',
      );
      throw new Error(`Telnyx Messages API returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok) {
      const detail = parsed.errors?.[0]?.detail ?? `HTTP ${res.status}`;
      this.log.error({ status: res.status, detail }, 'sms-client: Telnyx send failed');
      throw new Error(`Telnyx send failed: ${detail}`);
    }

    const messageId = parsed.data?.id;
    if (!messageId) {
      throw new Error('Telnyx send succeeded but response lacked data.id');
    }

    this.log.info({ destinationType: '1:1' }, 'sms-client: SMS sent via Telnyx');
    return { messageId };
  }
}

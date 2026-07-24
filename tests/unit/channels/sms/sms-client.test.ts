import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { SmsClient, TelnyxSendError } from '../../../../src/channels/sms/sms-client.js';
import { TELNYX_ERROR_OPTED_OUT } from '../../../../src/channels/sms/types.js';

describe('SmsClient', () => {
  it('maps Telnyx error 40300 to TelnyxSendError with opted-out message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        errors: [{ code: TELNYX_ERROR_OPTED_OUT, detail: 'Blocked due to STOP' }],
      }),
    });

    const client = new SmsClient({
      apiKey: 'KEY',
      fromNumber: '+14155550000',
      webhookPublicKey: 'dGVzdA==',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.sendSms({ to: '+14155552671', text: 'hi' }),
    ).rejects.toMatchObject({
      name: 'TelnyxSendError',
      code: TELNYX_ERROR_OPTED_OUT,
      message: 'recipient opted out at carrier (STOP)',
    } satisfies Partial<TelnyxSendError>);
  });

  it('returns messageId on success and pins From to the configured office DID', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { id: 'msg_1' } }),
    });

    const client = new SmsClient({
      apiKey: 'KEY',
      fromNumber: '+14155550000',
      webhookPublicKey: 'dGVzdA==',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.sendSms({ to: '+14155552671', text: 'hi' }),
    ).resolves.toEqual({ messageId: 'msg_1' });

    // The wire body must carry the configured office DID, not a caller value.
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      from: string;
      to: string;
    };
    expect(body.from).toBe('+14155550000');
    expect(body.to).toBe('+14155552671');
  });
});

// The default readiness client uses a short per-request timeout (H): setup-status runs readiness
// inside a 15 s tool timeout, and readiness makes two Nylas calls in a row.
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

const ctorArgs: Array<Record<string, unknown>> = [];
vi.mock('../../../src/nylas/app-client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/nylas/app-client.js')>();
  class RecordingClient {
    constructor(opts: Record<string, unknown>) { ctorArgs.push(opts); }
    async getApplication() {
      return { applicationId: 'app-1', region: 'us', environment: 'production', callbackUris: ['https://curia.example.com/api/mailbox-signin/callback'] };
    }
    async listConnectors() { return [{ provider: 'google', scopes: [] }]; }
  }
  return { ...orig, NylasAppClient: RecordingClient };
});

const { checkNylasSignIn, READINESS_TIMEOUT_MS } = await import('../../../src/nylas/signin-readiness.js');

describe('checkNylasSignIn default client', () => {
  it('is built with a 5000 ms timeout, so two calls fit in the 15 s tool timeout', async () => {
    const r = await checkNylasSignIn({
      readApiKey: async () => 'key',
      readRegion: async () => 'us',
      appOrigin: 'https://curia.example.com',
      logger: pino({ level: 'silent' }),
    });
    expect(r).toMatchObject({ ready: true });
    expect(READINESS_TIMEOUT_MS).toBe(5000);
    expect(ctorArgs[0]).toMatchObject({ timeoutMs: 5000 });
  });
});

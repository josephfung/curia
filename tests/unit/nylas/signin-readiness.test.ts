import { describe, it, expect, vi } from 'vitest';
import {
  checkNylasSignIn,
  mailboxSignInCallbackUrl,
  type NylasSignInReadiness,
} from '../../../src/nylas/signin-readiness.js';
import { NylasAppError, type NylasAppClient } from '../../../src/nylas/app-client.js';

const ORIGIN = 'https://curia.example.com';
const CALLBACK = `${ORIGIN}/api/mailbox-signin/callback`;

interface FakeOpts {
  environment?: string | null;
  callbackUris?: string[];
  connectors?: Array<{ provider: string; scopes: string[] }>;
  appError?: Error;
}

function fakeClient(o: FakeOpts = {}): NylasAppClient {
  return {
    getApplication: vi.fn(async () => {
      if (o.appError) throw o.appError;
      return {
        applicationId: 'app-1',
        region: 'us',
        environment: o.environment === undefined ? 'production' : o.environment,
        callbackUris: o.callbackUris ?? [CALLBACK],
      };
    }),
    listConnectors: vi.fn(async () => o.connectors ?? [{ provider: 'google', scopes: [] }]),
  } as unknown as NylasAppClient;
}

function run(o: FakeOpts = {}, over: Partial<Parameters<typeof checkNylasSignIn>[0]> = {}): Promise<NylasSignInReadiness> {
  return checkNylasSignIn({
    readApiKey: async () => 'key',
    readRegion: async () => 'us',
    appOrigin: ORIGIN,
    makeClient: () => fakeClient(o),
    ...over,
  });
}

describe('mailboxSignInCallbackUrl', () => {
  it('appends the callback path, tolerating a trailing slash', () => {
    expect(mailboxSignInCallbackUrl(ORIGIN)).toBe(CALLBACK);
    expect(mailboxSignInCallbackUrl(`${ORIGIN}/`)).toBe(CALLBACK);
  });
});

describe('checkNylasSignIn', () => {
  it('no key', async () => {
    expect(await run({}, { readApiKey: async () => undefined })).toMatchObject({ ready: false, reason: 'no_api_key' });
    expect(await run({}, { readApiKey: async () => '  ' })).toMatchObject({ ready: false, reason: 'no_api_key' });
  });

  it('origin not https (checked before any Nylas call)', async () => {
    const makeClient = vi.fn(() => fakeClient());
    const r = await run({}, { appOrigin: 'http://curia.local', makeClient });
    expect(r).toMatchObject({ ready: false, reason: 'origin_not_https' });
    expect(makeClient).not.toHaveBeenCalled();
    expect(await run({}, { appOrigin: undefined })).toMatchObject({ ready: false, reason: 'origin_not_https' });
  });

  it.each([401, 403])('bad key on %i', async (status) => {
    expect(await run({ appError: new NylasAppError('x', status) })).toMatchObject({ ready: false, reason: 'bad_api_key' });
  });

  it.each([0, 500, 503])('unreachable on %i', async (status) => {
    expect(await run({ appError: new NylasAppError('x', status) })).toMatchObject({ ready: false, reason: 'nylas_unreachable' });
  });

  it('an unexpected error is unreachable, not a throw', async () => {
    expect(await run({ appError: new Error('boom') })).toMatchObject({ ready: false, reason: 'nylas_unreachable' });
  });

  it('sandbox, case-insensitive', async () => {
    expect(await run({ environment: 'Sandbox' })).toMatchObject({ ready: false, reason: 'sandbox' });
  });

  it('callback not registered', async () => {
    expect(await run({ callbackUris: ['https://other/cb'] })).toMatchObject({ ready: false, reason: 'callback_unregistered' });
  });

  it('no google connector', async () => {
    expect(await run({ connectors: [{ provider: 'microsoft', scopes: [] }] })).toMatchObject({ ready: false, reason: 'no_google_connector' });
  });

  it('ready when everything is present', async () => {
    expect(await run()).toEqual({ ready: true, applicationId: 'app-1', region: 'us' });
  });

  it('detail never carries the key', async () => {
    const r = await run({ appError: new NylasAppError('x', 401) }, { readApiKey: async () => 'nyk_secret' });
    expect(JSON.stringify(r)).not.toContain('nyk_secret');
  });

  it('reads the key and region live on every call', async () => {
    let key: string | undefined;
    let region: 'us' | 'eu' = 'us';
    const makeClient = vi.fn((_k: string, _u: string) => fakeClient());
    const deps = { readApiKey: async () => key, readRegion: async () => region, appOrigin: ORIGIN, makeClient };
    expect((await checkNylasSignIn(deps))).toMatchObject({ reason: 'no_api_key' });
    key = 'late-key';
    region = 'eu';
    expect(await checkNylasSignIn(deps)).toMatchObject({ ready: true, region: 'eu' });
    expect(makeClient).toHaveBeenCalledWith('late-key', 'https://api.eu.nylas.com');
  });
});

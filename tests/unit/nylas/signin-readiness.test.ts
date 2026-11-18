import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  checkNylasSignIn,
  createNylasSignInReaders,
  mailboxSignInCallbackUrl,
  NYLAS_REGION_SECRET,
  NylasSettingsReadError,
  type NylasSignInReadiness,
} from '../../../src/nylas/signin-readiness.js';
import { NylasAppError, type NylasAppClient } from '../../../src/nylas/app-client.js';

const ORIGIN = 'https://curia.example.com';
const CALLBACK = `${ORIGIN}/api/mailbox-signin/callback`;

/** A logger whose lines are kept, to check what the catch logs (H). */
function capture(): { logger: pino.Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(JSON.parse(s) as Record<string, unknown>); } });
  return { logger, lines };
}
const silent = pino({ level: 'silent' });

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
    logger: silent,
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
    const deps = { readApiKey: async () => key, readRegion: async () => region, appOrigin: ORIGIN, makeClient, logger: silent };
    expect((await checkNylasSignIn(deps))).toMatchObject({ reason: 'no_api_key' });
    key = 'late-key';
    region = 'eu';
    expect(await checkNylasSignIn(deps)).toMatchObject({ ready: true, region: 'eu' });
    expect(makeClient).toHaveBeenCalledWith('late-key', 'https://api.eu.nylas.com');
  });

  it('restart_required when a key is saved after a boot that had none (D, R11)', async () => {
    const makeClient = vi.fn(() => fakeClient());
    const r = await run({}, { boot: { apiKey: undefined, region: 'us' }, makeClient });
    expect(r).toMatchObject({ ready: false, reason: 'restart_required', detail: 'Restart Curia to finish setting up sign-in.' });
    expect(makeClient).not.toHaveBeenCalled();
  });

  it('restart_required when the live key differs from the boot key', async () => {
    expect(await run({}, { boot: { apiKey: 'old-key', region: 'us' } })).toMatchObject({ reason: 'restart_required' });
  });

  it('restart_required when the region changed after boot (D, R11)', async () => {
    expect(await run({}, { readRegion: async () => 'eu', boot: { apiKey: 'key', region: 'us' } })).toMatchObject({ reason: 'restart_required' });
  });

  it('ready when the live key and region match the boot values', async () => {
    expect(await run({}, { boot: { apiKey: ' key ', region: 'us' } })).toMatchObject({ ready: true });
  });

  it('logs a Nylas failure at warn with its step and status, never the key (H)', async () => {
    const { logger, lines } = capture();
    await run({ appError: new NylasAppError('Nylas get application failed: HTTP 503', 503) }, { logger, readApiKey: async () => 'nyk_secret' });
    const warn = lines.find((l) => l['level'] === 40 && l['step'] === 'get_application');
    expect(warn).toMatchObject({ errName: 'NylasAppError', statusCode: 503 });
    expect(JSON.stringify(lines)).not.toContain('nyk_secret');
  });

  it('logs a non-Nylas error (a bug) at error and still reports unreachable (H)', async () => {
    const { logger, lines } = capture();
    const r = await run({ appError: new TypeError('x is undefined') }, { logger });
    expect(r).toMatchObject({ reason: 'nylas_unreachable' });
    expect(lines.find((l) => l['level'] === 50 && l['step'] === 'get_application')).toBeDefined();
  });
});

describe('createNylasSignInReaders', () => {
  const failingVault = { get: async (): Promise<string | null> => { throw new Error('vault down'); } };

  it('uses the environment only when the vault holds no value', async () => {
    const readers = createNylasSignInReaders({ secrets: { get: async () => null }, env: { NYLAS_API_KEY: 'nyk_env', NYLAS_REGION: 'eu' }, logger: silent });
    expect(await readers.readApiKey()).toBe('nyk_env');
    expect(await readers.readRegion()).toBe('eu');
  });

  it('a failed vault read throws instead of falling back to the environment', async () => {
    const { logger, lines } = capture();
    const readers = createNylasSignInReaders({ secrets: failingVault, env: { NYLAS_API_KEY: 'nyk_env', NYLAS_REGION: 'eu' }, logger });
    await expect(readers.readApiKey()).rejects.toBeInstanceOf(NylasSettingsReadError);
    await expect(readers.readRegion()).rejects.toBeInstanceOf(NylasSettingsReadError);
    expect(lines.filter((l) => l['level'] === 50)).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('nyk_env');
  });

  it('an invalid vault region gives way to a valid env region, and is never logged', async () => {
    const { logger, lines } = capture();
    const readers = createNylasSignInReaders({ secrets: { get: async (n) => (n === NYLAS_REGION_SECRET ? 'nyk_pasted' : null) }, env: { NYLAS_REGION: 'eu' }, logger });
    expect(await readers.readRegion()).toBe('eu');
    expect(lines.find((l) => l['level'] === 40)).toMatchObject({ rejectedSources: ['vault'], using: 'eu' });
    expect(JSON.stringify(lines)).not.toContain('nyk_pasted');
  });

  it('readiness reports settings_unreadable when the vault read fails, without calling Nylas', async () => {
    const readers = createNylasSignInReaders({ secrets: failingVault, env: { NYLAS_API_KEY: 'nyk_env' }, logger: silent });
    const makeClient = vi.fn(() => fakeClient());
    const r = await checkNylasSignIn({ ...readers, appOrigin: ORIGIN, makeClient, logger: silent });
    expect(r).toMatchObject({ ready: false, reason: 'settings_unreadable' });
    expect(makeClient).not.toHaveBeenCalled();
  });
});

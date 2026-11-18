import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { NylasAppClient, NylasAppError } from '../../../src/nylas/app-client.js';

const logger = pino({ level: 'silent' });
const KEY = 'nyk_super_secret_key';
const API = 'https://api.us.nylas.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup(res: Response | (() => Response)) {
  const fetchImpl = vi.fn(async () => (typeof res === 'function' ? res() : res));
  const client = new NylasAppClient({ apiKey: KEY, apiUri: API, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { fetchImpl, client };
}

function call(fetchImpl: ReturnType<typeof vi.fn>, n = 0): { url: string; init: RequestInit } {
  const c = fetchImpl.mock.calls[n] as unknown as [string, RequestInit];
  return { url: c[0], init: c[1] };
}

function authHeader(init: RequestInit): string {
  return (init.headers as Record<string, string>)['Authorization']!;
}

describe('NylasAppClient', () => {
  it('getApplication parses the application', async () => {
    const { fetchImpl, client } = setup(json({
      request_id: 'r',
      data: { application_id: 'app-1', region: 'us', environment: 'production', callback_uris: [{ id: '1', url: 'https://a/cb', platform: 'web' }] },
    }));
    const app = await client.getApplication();
    expect(app).toEqual({ applicationId: 'app-1', region: 'us', environment: 'production', callbackUris: ['https://a/cb'] });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/applications`);
    expect(init.method).toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
  });

  it('getApplication treats a missing environment as null', async () => {
    const { client } = setup(json({ data: { application_id: 'a', region: 'eu' } }));
    expect(await client.getApplication()).toEqual({ applicationId: 'a', region: 'eu', environment: null, callbackUris: [] });
  });

  it('addCallbackUri posts the url as a web redirect uri', async () => {
    const { fetchImpl, client } = setup(json({ data: {} }));
    await client.addCallbackUri('https://x.example/api/mailbox-signin/callback');
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/applications/redirect-uris`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({ url: 'https://x.example/api/mailbox-signin/callback', platform: 'web' });
  });

  it('listConnectors maps scopes and the non-secret client id, never the secret', async () => {
    const { fetchImpl, client } = setup(json({
      data: [
        { provider: 'google', scope: ['s1', 's2'], settings: { client_id: 'gcp-id', client_secret: 'LEAK' } },
        { provider: 'microsoft', scope: ['m'] },
      ],
    }));
    const out = await client.listConnectors();
    expect(out).toEqual([
      { provider: 'google', scopes: ['s1', 's2'], clientId: 'gcp-id' },
      { provider: 'microsoft', scopes: ['m'] },
    ]);
    expect(JSON.stringify(out)).not.toContain('LEAK');
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/connectors?limit=50`);
    expect(init.method).toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
  });

  it('createGoogleConnector posts provider, settings and scope', async () => {
    const { fetchImpl, client } = setup(json({ data: {} }));
    await client.createGoogleConnector({ clientId: 'cid', clientSecret: 'csec', topicName: 'projects/p/topics/t', scopes: ['a', 'b'] });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/connectors`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      provider: 'google',
      settings: { client_id: 'cid', client_secret: 'csec', topic_name: 'projects/p/topics/t' },
      scope: ['a', 'b'],
    });
  });

  it('createGoogleConnector omits topic_name when not given', async () => {
    const { fetchImpl, client } = setup(json({ data: {} }));
    await client.createGoogleConnector({ clientId: 'cid', clientSecret: 'csec', scopes: ['a'] });
    const body = JSON.parse(call(fetchImpl).init.body as string) as { settings: Record<string, unknown> };
    expect(body.settings).not.toHaveProperty('topic_name');
  });

  it('buildAuthUrl url-encodes the space-joined scopes and sets the fixed params', () => {
    const { client } = setup(json({}));
    const raw = client.buildAuthUrl({
      clientId: 'app-1',
      redirectUri: 'https://x.example/api/mailbox-signin/callback',
      state: 'st',
      loginHint: 'a@b.com',
      scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar'],
    });
    expect(raw.startsWith(`${API}/v3/connect/auth?`)).toBe(true);
    const u = new URL(raw);
    expect(u.searchParams.get('client_id')).toBe('app-1');
    expect(u.searchParams.get('redirect_uri')).toBe('https://x.example/api/mailbox-signin/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('provider')).toBe('google');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('login_hint')).toBe('a@b.com');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar');
    expect(raw).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify');
    expect(raw).not.toContain(' ');
  });

  it('buildAuthUrl omits login_hint when absent', () => {
    const { client } = setup(json({}));
    const u = new URL(client.buildAuthUrl({ clientId: 'c', redirectUri: 'https://x/cb', state: 's', scopes: ['a'] }));
    expect(u.searchParams.has('login_hint')).toBe(false);
  });

  it('exchangeCode sends the API key as client_secret and parses an unwrapped response', async () => {
    const { fetchImpl, client } = setup(json({ grant_id: 'g-1', email: 'me@x.com', scope: 'a b  c', access_token: 'TOK' }));
    const out = await client.exchangeCode({ clientId: 'app-1', code: 'the-code', redirectUri: 'https://x/cb' });
    expect(out).toEqual({ grantId: 'g-1', email: 'me@x.com', scopes: ['a', 'b', 'c'] });
    expect(JSON.stringify(out)).not.toContain('TOK');
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/connect/token`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: 'app-1',
      client_secret: KEY,
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://x/cb',
    });
  });

  it('exchangeCode tolerates a missing email and scope', async () => {
    const { client } = setup(json({ grant_id: 'g-1' }));
    expect(await client.exchangeCode({ clientId: 'a', code: 'c', redirectUri: 'https://x/cb' })).toEqual({
      grantId: 'g-1',
      email: null,
      scopes: [],
    });
  });

  it('getGrant parses the grant', async () => {
    const { fetchImpl, client } = setup(json({
      data: { id: 'g-1', email: 'me@x.com', provider: 'google', grant_status: 'valid', scope: ['s1'] },
    }));
    expect(await client.getGrant('g-1')).toEqual({ email: 'me@x.com', provider: 'google', scopes: ['s1'], status: 'valid' });
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/grants/g-1`);
    expect(init.method).toBe('GET');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
  });

  it('getGrant reads any status other than valid as invalid', async () => {
    const { client } = setup(json({ data: { id: 'g', email: 'e', provider: 'google', grant_status: 'weird', scope: [] } }));
    expect((await client.getGrant('g')).status).toBe('invalid');
  });

  it('deleteGrant sends DELETE', async () => {
    const { fetchImpl, client } = setup(json({ request_id: 'r' }));
    await client.deleteGrant('g-1');
    const { url, init } = call(fetchImpl);
    expect(url).toBe(`${API}/v3/grants/g-1`);
    expect(init.method).toBe('DELETE');
    expect(authHeader(init)).toBe(`Bearer ${KEY}`);
  });

  describe('errors', () => {
    const ops: Array<[string, (c: NylasAppClient) => Promise<unknown>]> = [
      ['getApplication', (c) => c.getApplication()],
      ['addCallbackUri', (c) => c.addCallbackUri('https://x/cb')],
      ['listConnectors', (c) => c.listConnectors()],
      ['createGoogleConnector', (c) => c.createGoogleConnector({ clientId: 'c', clientSecret: 's', scopes: [] })],
      ['exchangeCode', (c) => c.exchangeCode({ clientId: 'c', code: 'AUTH-CODE-XYZ', redirectUri: 'https://x/cb' })],
      ['getGrant', (c) => c.getGrant('grant-secret-id')],
      ['deleteGrant', (c) => c.deleteGrant('grant-secret-id')],
    ];

    it.each(ops)('%s: a 401 becomes NylasAppError without secrets in the message', async (_name, run) => {
      const { client } = setup(() =>
        json({ error: { type: 'authentication_error', message: `bad key ${KEY} grant grant-secret-id code AUTH-CODE-XYZ` } }, 401));
      const err = await run(client).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      const e = err as NylasAppError;
      expect(e.status).toBe(401);
      expect(e.nylasType).toBe('authentication_error');
      for (const secret of [KEY, 'grant-secret-id', 'AUTH-CODE-XYZ']) {
        expect(e.message).not.toContain(secret);
      }
    });

    it('a non-JSON error body still yields a NylasAppError with the status', async () => {
      const { client } = setup(() => new Response('<html>oops</html>', { status: 502 }));
      const err = await client.getApplication().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(502);
      expect((err as NylasAppError).nylasType).toBeUndefined();
    });

    it('a network failure is a NylasAppError with status 0 and no secrets', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error(`connect failed with ${KEY}`); });
      const client = new NylasAppClient({ apiKey: KEY, apiUri: API, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
      const err = await client.getApplication().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(0);
      expect((err as NylasAppError).message).not.toContain(KEY);
    });
  });

  describe('malformed 2xx bodies', () => {
    it('getApplication without application_id throws with the HTTP status', async () => {
      const { client } = setup(json({ data: { region: 'us' } }));
      const err = await client.getApplication().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(200);
    });

    it.each([
      ['id', { email: 'e', provider: 'google', grant_status: 'valid', scope: [] }],
      ['email', { id: 'g', provider: 'google', grant_status: 'valid', scope: [] }],
      ['grant_status', { id: 'g', email: 'e', provider: 'google', scope: [] }],
    ])('getGrant without %s throws', async (_f, data) => {
      const { client } = setup(json({ data }));
      const err = await client.getGrant('g').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(200);
      expect((err as NylasAppError).message).not.toContain('g-secret');
    });

    it('exchangeCode 200 without grant_id throws', async () => {
      const { client } = setup(json({ email: 'a@b.com', scope: 'x' }));
      const err = await client.exchangeCode({ clientId: 'a', code: 'c', redirectUri: 'https://x/cb' }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(200);
    });
  });

  describe('timeout and url', () => {
    it('a timeout becomes status 0 with a "timed out" message and passes a signal', async () => {
      const fetchImpl = vi.fn(async () => { throw new DOMException('too slow', 'TimeoutError'); });
      const client = new NylasAppClient({ apiKey: KEY, apiUri: API, logger, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 });
      const err = await client.getApplication().then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(NylasAppError);
      expect((err as NylasAppError).status).toBe(0);
      expect((err as NylasAppError).message).toContain('timed out');
      expect(call(fetchImpl).init.signal).toBeInstanceOf(AbortSignal);
    });

    it('probeRegion passes a signal and treats a timeout as a miss', async () => {
      const fetchImpl = vi.fn(async () => { throw new DOMException('too slow', 'TimeoutError'); });
      expect(await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch)).toEqual({ region: null, unreachable: true });
      expect(call(fetchImpl).init.signal).toBeInstanceOf(AbortSignal);
    });

    it('strips trailing slashes from apiUri', async () => {
      const fetchImpl = vi.fn(async () => json({ data: {} }));
      const client = new NylasAppClient({ apiKey: KEY, apiUri: `${API}//`, logger, fetchImpl: fetchImpl as unknown as typeof fetch });
      await client.addCallbackUri('https://x/cb');
      expect(call(fetchImpl).url).toBe(`${API}/v3/applications/redirect-uris`);
    });
  });

  describe('probeRegion', () => {
    it('returns eu when us is 401 and eu is 200', async () => {
      const fetchImpl = vi.fn(async (url: string) =>
        url.startsWith('https://api.us.') ? json({}, 401) : json({ data: { application_id: 'a' } }));
      const region = await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch);
      expect(region).toEqual({ region: 'eu' });
      expect(fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
        'https://api.us.nylas.com/v3/applications',
        'https://api.eu.nylas.com/v3/applications',
      ]);
    });

    it('returns us without trying eu when us answers 200', async () => {
      const fetchImpl = vi.fn(async () => json({ data: {} }));
      expect(await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch)).toEqual({ region: 'us' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('a throw on either region is unreachable, not a rejected key (G)', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.startsWith('https://api.us.')) return json({}, 401);
        throw new Error('network');
      });
      expect(await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch)).toEqual({ region: null, unreachable: true });
    });

    it.each([500, 503, 429])('a %i is unreachable (G)', async (status) => {
      const fetchImpl = vi.fn(async (url: string) => (url.startsWith('https://api.us.') ? json({}, 403) : json({}, status)));
      expect(await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch)).toEqual({ region: null, unreachable: true });
    });

    it('both regions 401/403 is a rejected key, not unreachable (G)', async () => {
      const fetchImpl = vi.fn(async (url: string) => json({}, url.startsWith('https://api.us.') ? 401 : 403));
      expect(await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch)).toEqual({ region: null, unreachable: false });
    });

    it('logs the error name and status per region, never the key (G)', async () => {
      const lines: Array<Record<string, unknown>> = [];
      const log = pino({ level: 'debug' }, { write: (s: string) => { lines.push(JSON.parse(s) as Record<string, unknown>); } });
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.startsWith('https://api.us.')) return json({}, 503);
        throw new TypeError('fetch failed');
      });
      await NylasAppClient.probeRegion(KEY, fetchImpl as unknown as typeof fetch, undefined, log);
      expect(lines.find((l) => l['region'] === 'us')).toMatchObject({ status: 503 });
      expect(lines.find((l) => l['region'] === 'eu')).toMatchObject({ errorName: 'TypeError' });
      expect(JSON.stringify(lines)).not.toContain(KEY);
    });
  });
});

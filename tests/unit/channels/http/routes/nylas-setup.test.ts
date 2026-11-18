// nylas-setup.test.ts — console routes that set up Nylas mailbox sign-in from the API key (#2361).
import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { nylasSetupRoutes, type NylasSetupRouteOptions } from '../../../../../src/channels/http/routes/nylas-setup.js';
import { NylasAppError, type NylasAppClient } from '../../../../../src/nylas/app-client.js';
import { MailboxSignInAddressError, MailboxSignInUnavailableError } from '../../../../../src/nylas/mailbox-signin-service.js';

const BOOTSTRAP = 'test-bootstrap-secret';
const auth = { 'x-web-bootstrap-secret': BOOTSTRAP };
const ORIGIN = 'https://curia.example.com';
const CALLBACK = `${ORIGIN}/api/mailbox-signin/callback`;
const API_KEY = 'nyk_live_key_value';
const GCP_SECRET = 'GOCSPX-super-secret-value';

function makeClient(over: Record<string, unknown> = {}) {
  return {
    getApplication: vi.fn(async () => ({ applicationId: 'app-1', region: 'us', environment: 'production', callbackUris: [CALLBACK] })),
    listConnectors: vi.fn(async () => [{ provider: 'google', scopes: [] }]),
    addCallbackUri: vi.fn(async () => {}),
    createGoogleConnector: vi.fn(async () => {}),
    ...over,
  };
}

function setup(over: Partial<NylasSetupRouteOptions> = {}, store: Record<string, string> = { 'channel.email.nylas_api_key': API_KEY }) {
  const client = makeClient();
  const secrets = {
    get: vi.fn(async (n: string) => store[n] ?? null),
    set: vi.fn(async (n: string, v: string) => { store[n] = v; }),
  };
  const opts: NylasSetupRouteOptions = {
    secretsService: secrets,
    appOrigin: ORIGIN,
    webAppBootstrapSecret: BOOTSTRAP,
    sessions: new Map(),
    bus: { publish: vi.fn(async () => {}) },
    logger: pino({ level: 'silent' }),
    makeClient: vi.fn(() => client as unknown as NylasAppClient),
    probeRegion: vi.fn(async () => 'eu' as const),
    env: {},
    ...over,
  };
  return { opts, client, secrets, store };
}

describe('nylas-setup routes', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app?.close(); });
  async function build(opts: NylasSetupRouteOptions, logger?: pino.Logger) {
    app = (logger ? Fastify({ loggerInstance: logger }) : Fastify()) as unknown as FastifyInstance;
    await app.register(nylasSetupRoutes, opts);
  }
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as object }) });
  const audited = (opts: NylasSetupRouteOptions) =>
    vi.mocked(opts.bus.publish).mock.calls.map(([, e]) => e.payload as unknown as Record<string, unknown>);

  it('401s without auth on every route', async () => {
    await build(setup().opts);
    for (const [m, u] of [
      ['GET', '/api/registry/nylas/signin'], ['POST', '/api/registry/nylas/discover-region'],
      ['PUT', '/api/registry/nylas/region'], ['POST', '/api/registry/nylas/callback'],
      ['POST', '/api/registry/nylas/google-connector'],
    ] as const) {
      const res = await app.inject({ method: m, url: u, payload: {} });
      expect(res.statusCode, `${m} ${u}`).toBe(401);
    }
  });

  it('GET /signin reports readiness plus the callback and Google redirect URLs', async () => {
    const { opts } = setup();
    await build(opts);
    const res = await req('GET', '/api/registry/nylas/signin');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ready: true, applicationId: 'app-1', region: 'us',
      callbackUrl: CALLBACK, googleRedirectUri: 'https://api.us.nylas.com/v3/connect/callback',
    });
    expect(res.body).not.toContain(API_KEY);
  });

  it('GET /signin with no key says no_api_key without calling Nylas', async () => {
    const { opts } = setup({}, {});
    await build(opts);
    const res = await req('GET', '/api/registry/nylas/signin');
    expect(res.json()).toMatchObject({ ready: false, reason: 'no_api_key' });
    expect(opts.makeClient).not.toHaveBeenCalled();
  });

  it('POST /discover-region probes with the saved key and persists the region', async () => {
    const { opts, secrets } = setup();
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/discover-region');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ region: 'eu' });
    expect(opts.probeRegion).toHaveBeenCalledWith(API_KEY);
    expect(secrets.set).toHaveBeenCalledWith('channel.email.nylas_region', 'eu');
    expect(audited(opts).map(p => [p['action'], p['stage']])).toEqual([['nylas_region', 'requested'], ['nylas_region', 'completed']]);
  });

  it('POST /discover-region 422s when neither region accepts the key, and writes nothing', async () => {
    const { opts, secrets } = setup({ probeRegion: vi.fn(async () => null) });
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/discover-region');
    expect(res.statusCode).toBe(422);
    expect(secrets.set).not.toHaveBeenCalled();
  });

  it('PUT /region validates and persists', async () => {
    const { opts, secrets } = setup();
    await build(opts);
    expect((await req('PUT', '/api/registry/nylas/region', { region: 'mars' })).statusCode).toBe(400);
    expect(secrets.set).not.toHaveBeenCalled();
    const ok = await req('PUT', '/api/registry/nylas/region', { region: 'EU' });
    expect(ok.statusCode).toBe(200);
    expect(secrets.set).toHaveBeenCalledWith('channel.email.nylas_region', 'eu');
  });

  it('POST /callback registers the exact callback URL', async () => {
    const { opts, client } = setup();
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/callback');
    expect(res.statusCode).toBe(200);
    expect(client.addCallbackUri).toHaveBeenCalledWith(CALLBACK);
    expect(audited(opts).map(p => p['action'])).toEqual(['nylas_callback', 'nylas_callback']);
  });

  it('POST /callback refuses when APP_ORIGIN is not https', async () => {
    const { opts, client } = setup({ appOrigin: 'http://curia.local' });
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/callback');
    expect(res.statusCode).toBe(409);
    expect(client.addCallbackUri).not.toHaveBeenCalled();
  });

  it('POST /callback maps a Nylas rejection to a fixed message', async () => {
    const { opts, client } = setup();
    client.addCallbackUri.mockRejectedValueOnce(new NylasAppError('Nylas add callback uri failed: HTTP 401', 401));
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/callback');
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/rejected the API key/);
  });

  it('POST /google-connector passes the secret on and never echoes or logs it', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (s: string) => { lines.push(s); } });
    const { opts, client } = setup({ logger });
    await build(opts, logger);
    const res = await req('POST', '/api/registry/nylas/google-connector', {
      client_id: 'abc.apps.googleusercontent.com', client_secret: GCP_SECRET, topic_name: 'projects/p/topics/t',
    });
    expect(res.statusCode).toBe(200);
    expect(client.createGoogleConnector).toHaveBeenCalledWith({
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: GCP_SECRET,
      topicName: 'projects/p/topics/t',
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/calendar',
      ],
    });
    expect(res.body).not.toContain(GCP_SECRET);
    expect(res.body).not.toContain(API_KEY);
    expect(lines.join('')).not.toContain(GCP_SECRET);
    expect(lines.join('')).not.toContain(API_KEY);
    expect(JSON.stringify(audited(opts))).not.toContain(GCP_SECRET);
  });

  it('POST /google-connector does not log the secret when Nylas fails', async () => {
    const lines: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (s: string) => { lines.push(s); } });
    const { opts, client } = setup({ logger });
    client.createGoogleConnector.mockRejectedValueOnce(new NylasAppError(`bad ${GCP_SECRET}`, 400, 'invalid_request'));
    await build(opts, logger);
    const res = await req('POST', '/api/registry/nylas/google-connector', { client_id: 'abc', client_secret: GCP_SECRET });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(GCP_SECRET);
    expect(lines.join('')).not.toContain(GCP_SECRET);
  });

  it('POST /google-connector requires a client id and secret and omits an empty topic', async () => {
    const { opts, client } = setup();
    await build(opts);
    expect((await req('POST', '/api/registry/nylas/google-connector', { client_id: 'abc' })).statusCode).toBe(400);
    expect((await req('POST', '/api/registry/nylas/google-connector', { client_secret: 's' })).statusCode).toBe(400);
    expect(client.createGoogleConnector).not.toHaveBeenCalled();
    await req('POST', '/api/registry/nylas/google-connector', { client_id: 'abc', client_secret: 's', topic_name: '  ' });
    expect((client.createGoogleConnector.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0]).not.toHaveProperty('topicName');
  });

  it('refuses the change when the audit write fails', async () => {
    const { opts, client } = setup({ bus: { publish: vi.fn(async () => { throw new Error('db'); }) } });
    await build(opts);
    const res = await req('POST', '/api/registry/nylas/callback');
    expect(res.statusCode).toBe(500);
    expect(client.addCallbackUri).not.toHaveBeenCalled();
  });

  it('POST routes 409 with no API key', async () => {
    const { opts } = setup({}, {});
    await build(opts);
    for (const u of ['/api/registry/nylas/discover-region', '/api/registry/nylas/callback']) {
      expect((await req('POST', u)).statusCode, u).toBe(409);
    }
  });

  describe('POST /signin-links', () => {
    const URL_OUT = 'https://curia.example.com/api/mailbox-signin/start/tok22';
    const expiresAt = new Date('2026-11-18T12:00:00Z');
    function withSignIn(over: Record<string, unknown> = {}) {
      const signIn = {
        mint: vi.fn(async () => ({ url: URL_OUT, expiresAt })),
        mintForOperator: vi.fn(async () => ({ url: URL_OUT, expiresAt })),
        ...over,
      };
      return { signIn, ...setup({ signIn } as Partial<NylasSetupRouteOptions>) };
    }

    it('401s without auth', async () => {
      await build(withSignIn().opts);
      const res = await app.inject({ method: 'POST', url: '/api/registry/nylas/signin-links', payload: { target: 'curia' } });
      expect(res.statusCode).toBe(401);
    });

    it('mints a Curia link with no pinned address', async () => {
      const { opts, signIn } = withSignIn();
      await build(opts);
      const res = await req('POST', '/api/registry/nylas/signin-links', { target: 'curia', label: ' Curia ' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ url: URL_OUT, expiresAt: expiresAt.toISOString() });
      expect(signIn.mintForOperator).toHaveBeenCalledWith({ target: 'curia', label: 'Curia' });
    });

    it('mints a principal link for the primary address by default', async () => {
      const { opts, signIn } = withSignIn();
      await build(opts);
      const res = await req('POST', '/api/registry/nylas/signin-links', { target: 'principal' });
      expect(res.statusCode).toBe(200);
      expect(signIn.mint).toHaveBeenCalledWith({ target: 'principal' });
    });

    it('pins a principal link to the address the operator names', async () => {
      const { opts, signIn } = withSignIn();
      await build(opts);
      await req('POST', '/api/registry/nylas/signin-links', { target: 'principal', address: ' Boss@Gmail.com ' });
      expect(signIn.mintForOperator).toHaveBeenCalledWith({ target: 'principal', expectedEmail: 'Boss@Gmail.com' });
    });

    it('rejects a bad target or an over-long label with 400', async () => {
      await build(withSignIn().opts);
      expect((await req('POST', '/api/registry/nylas/signin-links', { target: 'x' })).statusCode).toBe(400);
      expect((await req('POST', '/api/registry/nylas/signin-links', { target: 'curia', label: 'a'.repeat(200) })).statusCode).toBe(400);
    });

    it('maps unavailable to 409 and address problems to 422 without echoing a token', async () => {
      const a = withSignIn({ mintForOperator: vi.fn(async () => { throw new MailboxSignInUnavailableError('no_api_key', 'Save the Nylas API key first (Channels → Email).'); }) });
      await build(a.opts);
      const r1 = await req('POST', '/api/registry/nylas/signin-links', { target: 'curia' });
      expect(r1.statusCode).toBe(409);
      expect(r1.json().error).toContain('Save the Nylas API key');
      await app.close();
      const b = withSignIn({ mint: vi.fn(async () => { throw new MailboxSignInAddressError('no_principal_address'); }) });
      await build(b.opts);
      const r2 = await req('POST', '/api/registry/nylas/signin-links', { target: 'principal' });
      expect(r2.statusCode).toBe(422);
      expect(r2.body).not.toContain('tok22');
    });

    it('500s with a plain message on an unexpected error', async () => {
      const { opts } = withSignIn({ mintForOperator: vi.fn(async () => { throw new Error('db down tok22'); }) });
      await build(opts);
      const res = await req('POST', '/api/registry/nylas/signin-links', { target: 'curia' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('db down');
    });

    it('409s when sign-in is not wired', async () => {
      await build(setup().opts);
      expect((await req('POST', '/api/registry/nylas/signin-links', { target: 'curia' })).statusCode).toBe(409);
    });
  });
});

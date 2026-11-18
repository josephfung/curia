// Application-level Nylas v3 client (#2361): the calls that configure the Nylas application
// (callback URIs, the Google connector) and run hosted sign-in (auth URL, code exchange, grant
// lookup/removal). Separate from the per-mailbox clients, which act on a grant.
//
// Secrets: the API key, auth code and grant id never appear in an error message or a log line.
// Error messages are fixed per operation plus the HTTP status and Nylas's error type.

import type { Logger } from '../logger.js';
import { nylasApiUri } from './region.js';
import type { NylasRegion } from './region.js';

export class NylasAppError extends Error {
  readonly status: number;
  readonly nylasType?: string;

  constructor(message: string, status: number, nylasType?: string) {
    super(message);
    this.name = 'NylasAppError';
    this.status = status;
    if (nylasType !== undefined) this.nylasType = nylasType;
  }
}

export interface NylasApplicationInfo {
  applicationId: string;
  region: string;
  environment: string | null;
  callbackUris: string[];
}

export interface NylasConnectorInfo {
  provider: string;
  scopes: string[];
  clientId?: string;
}

export interface NylasGrantInfo {
  email: string;
  provider: string;
  scopes: string[];
  status: 'valid' | 'invalid';
}

export interface NylasAppClientOptions {
  apiKey: string;
  apiUri: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 15000. */
  timeoutMs?: number;
}

// One page of connectors is enough: an application has a handful of providers.
const CONNECTOR_PAGE_LIMIT = 50;
const DEFAULT_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function splitScopes(v: unknown): string[] {
  return typeof v === 'string' ? v.split(/\s+/).filter((s) => s !== '') : [];
}

export class NylasAppClient {
  private readonly apiKey: string;
  private readonly apiUri: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: NylasAppClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiUri = opts.apiUri.replace(/\/+$/, '');
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Find which region the API key belongs to. Tries us, then eu; the first 200 wins.
   * Null when neither accepts the key (or both are unreachable).
   */
  static async probeRegion(
    apiKey: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<NylasRegion | null> {
    for (const region of ['us', 'eu'] as const) {
      try {
        const res = await fetchImpl(`${nylasApiUri(region)}/v3/applications`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 200) return region;
      } catch {
        // A network failure on one region is not an answer; the next region (or null) is.
        // Not logged: the error text could carry the request URL, and the caller reports null.
        continue;
      }
    }
    return null;
  }

  async getApplication(): Promise<NylasApplicationInfo> {
    const { status, data } = await this.request('GET', '/v3/applications', undefined, 'get application');
    const d = isObject(data) ? data : {};
    const applicationId = str(d['application_id']);
    if (applicationId === undefined || applicationId === '') {
      throw new NylasAppError('Nylas get application: response carried no application id', status);
    }
    const callbackUris = Array.isArray(d['callback_uris'])
      ? d['callback_uris'].flatMap((c) => (isObject(c) && typeof c['url'] === 'string' ? [c['url']] : []))
      : [];
    return {
      applicationId,
      region: str(d['region']) ?? '',
      environment: str(d['environment']) ?? null,
      callbackUris,
    };
  }

  async addCallbackUri(url: string): Promise<void> {
    await this.request('POST', '/v3/applications/redirect-uris', { url, platform: 'web' }, 'add callback uri');
  }

  async listConnectors(): Promise<NylasConnectorInfo[]> {
    const { data } = await this.request('GET', `/v3/connectors?limit=${CONNECTOR_PAGE_LIMIT}`, undefined, 'list connectors');
    if (!Array.isArray(data)) return [];
    const out: NylasConnectorInfo[] = [];
    for (const c of data) {
      if (!isObject(c)) continue;
      const provider = str(c['provider']);
      if (provider === undefined) continue;
      const info: NylasConnectorInfo = { provider, scopes: strArray(c['scope']) };
      // Only the non-secret client id is read; settings.client_secret is never touched.
      const clientId = isObject(c['settings']) ? str(c['settings']['client_id']) : undefined;
      if (clientId !== undefined) info.clientId = clientId;
      out.push(info);
    }
    return out;
  }

  async createGoogleConnector(input: {
    clientId: string;
    clientSecret: string;
    topicName?: string;
    scopes: string[];
  }): Promise<void> {
    const settings: JsonObject = { client_id: input.clientId, client_secret: input.clientSecret };
    if (input.topicName !== undefined) settings['topic_name'] = input.topicName;
    await this.request('POST', '/v3/connectors', { provider: 'google', settings, scope: input.scopes }, 'create google connector');
  }

  /** The hosted sign-in URL. Built locally; no request is made. */
  buildAuthUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    loginHint?: string;
    scopes: string[];
  }): string {
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      provider: 'google',
      state: input.state,
      access_type: 'offline',
      scope: input.scopes.join(' '),
    });
    if (input.loginHint !== undefined) params.set('login_hint', input.loginHint);
    // URLSearchParams encodes a space as '+'; use %20 so every consumer reads the scope list alike.
    return `${this.apiUri}/v3/connect/auth?${params.toString().replace(/\+/g, '%20')}`;
  }

  async exchangeCode(input: {
    clientId: string;
    code: string;
    redirectUri: string;
  }): Promise<{ grantId: string; email: string | null; scopes: string[] }> {
    // The token endpoint answers with the bare object, not the { data } wrapper. The
    // access_token in it is never read.
    const { status, data: body } = await this.request(
      'POST',
      '/v3/connect/token',
      {
        client_id: input.clientId,
        client_secret: this.apiKey,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
      },
      'exchange code',
      false,
    );
    const b = isObject(body) ? body : {};
    const grantId = str(b['grant_id']);
    if (grantId === undefined || grantId === '') {
      throw new NylasAppError('Nylas exchange code: response carried no grant', status);
    }
    return { grantId, email: str(b['email']) ?? null, scopes: splitScopes(b['scope']) };
  }

  async getGrant(grantId: string): Promise<NylasGrantInfo> {
    const { status, data } = await this.request('GET', `/v3/grants/${encodeURIComponent(grantId)}`, undefined, 'get grant');
    const d = isObject(data) ? data : {};
    const email = str(d['email']);
    const grantStatus = str(d['grant_status']);
    if (str(d['id']) === undefined || email === undefined || email === '' || grantStatus === undefined) {
      throw new NylasAppError('Nylas get grant: response was missing required fields', status);
    }
    return {
      email,
      provider: str(d['provider']) ?? '',
      scopes: strArray(d['scope']),
      status: grantStatus === 'valid' ? 'valid' : 'invalid',
    };
  }

  async deleteGrant(grantId: string): Promise<void> {
    await this.request('DELETE', `/v3/grants/${encodeURIComponent(grantId)}`, undefined, 'delete grant');
  }

  /**
   * One request. Returns the `data` member of the Nylas envelope (or the whole body when
   * `unwrap` is false). Non-2xx and network failures become NylasAppError with a fixed message.
   */
  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    operation: string,
    unwrap = true,
  ): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUri}${path}`, init);
    } catch (err) {
      // The underlying error text can carry the URL (which holds a grant id), so it is dropped.
      const errorName = err instanceof Error ? err.name : 'unknown';
      this.logger.warn({ operation, errorName }, 'Nylas application request failed to send');
      const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError';
      throw new NylasAppError(`Nylas ${operation} failed: ${timedOut ? 'timed out' : 'network error'}`, 0);
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      // An empty or non-JSON body: fine on a 2xx (e.g. DELETE), and for an error the status is the signal.
      parsed = undefined;
    }

    if (!res.ok) {
      const nylasType =
        isObject(parsed) && isObject(parsed['error']) ? str(parsed['error']['type']) : undefined;
      this.logger.warn({ operation, status: res.status, nylasType }, 'Nylas application request rejected');
      const suffix = nylasType !== undefined ? ` (${nylasType})` : '';
      throw new NylasAppError(`Nylas ${operation} failed: HTTP ${res.status}${suffix}`, res.status, nylasType);
    }

    if (!unwrap) return { status: res.status, data: parsed };
    return { status: res.status, data: isObject(parsed) ? parsed['data'] : undefined };
  }
}

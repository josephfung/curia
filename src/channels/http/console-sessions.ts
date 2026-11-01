// console-sessions.ts — browser and paired-device sessions (#2341, ADR-055).
//
// A session lasts 90 days from last use. Each authenticated request may push
// that window forward, but the database write and cookie re-issue are throttled
// to once an hour so a busy tab does not write on every call. The in-memory
// map and the sessions row stay in step: a failed write rolls the map back so
// the next request tries again.

import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../logger.js';
import { hashToken, type SessionEntry, type SessionStore } from './session-auth.js';

/** Idle lifetime. A session used inside this window never expires. */
export const SESSION_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Minimum gap between expiry writes for one session. */
export const SESSION_RENEW_INTERVAL_MS = 60 * 60 * 1000;

export const SESSION_NAME_MAX = 80;

const USER_AGENT_MAX = 512;

export type SessionKind = 'browser' | 'paired_device';

export interface SessionQueryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface IssuedSession {
  id: string;
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export interface DeviceSession {
  id: string;
  kind: SessionKind;
  name: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** Push subscriptions land in a later change. False until then. */
  notificationsEnabled: boolean;
}

export function sessionCookieOptions(secure: boolean): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_IDLE_TTL_MS / 1000,
  };
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie('curia_session', { path: '/' });
}

interface PendingCookie {
  name: string;
  value: string;
  opts?: Record<string, unknown>;
}

/**
 * @fastify/cookie keeps new cookies on a reply symbol and writes Set-Cookie
 * in onSend. Hijacked SSE responses never reach that hook, so flush the jar
 * onto the reply header first. The symbol is the plugin's private key
 * (`fastify.reply.setCookies`); there is no public flush.
 */
function flushPendingCookies(reply: FastifyReply, logger?: Pick<Logger, 'warn'>): void {
  const holder = reply as unknown as Record<symbol, unknown>;
  let jar: Map<string, PendingCookie> | undefined;
  for (const sym of Object.getOwnPropertySymbols(reply)) {
    if (sym.description !== 'fastify.reply.setCookies') continue;
    const value = holder[sym];
    if (value instanceof Map) jar = value as Map<string, PendingCookie>;
  }
  if (!jar || jar.size === 0) return;
  const serialize = (reply.server as {
    serializeCookie?: (name: string, value: string, opts?: Record<string, unknown>) => string;
  }).serializeCookie;
  if (!serialize) {
    logger?.warn('SSE renewal cookie was dropped: serializeCookie is unavailable');
    return;
  }
  const lines: string[] = [];
  for (const cookie of jar.values()) {
    lines.push(serialize(cookie.name, cookie.value, cookie.opts));
  }
  jar.clear();
  // Fastify 5 appends when set-cookie is already present, so a header cookie
  // set before the jar is kept alongside the renewal cookie.
  reply.header('set-cookie', lines.length === 1 ? lines[0]! : lines);
}

/**
 * SSE routes call `reply.hijack()` and `writeHead`, which skips @fastify/cookie's
 * onSend hook. Copy a renewal Set-Cookie onto the raw response or the browser
 * cookie lags the server's expiry until the next non-stream request.
 */
export function writeSseHead(
  reply: FastifyReply,
  headers: Record<string, string>,
  logger?: Pick<Logger, 'warn'>,
): void {
  flushPendingCookies(reply, logger);
  const setCookie = reply.getHeader('set-cookie');
  const merged: Record<string, string | string[] | number> = { ...headers };
  if (typeof setCookie === 'string' || typeof setCookie === 'number') merged['set-cookie'] = String(setCookie);
  else if (Array.isArray(setCookie)) merged['set-cookie'] = setCookie.map(String);
  reply.raw.writeHead(200, merged);
}

export function readUserAgent(request: FastifyRequest): string | null {
  const ua = request.headers['user-agent'];
  if (typeof ua !== 'string') return null;
  const trimmed = ua.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, USER_AGENT_MAX);
}

/**
 * A short label for the Devices page. The raw user agent is stored separately.
 * iPhone Safari is the pairing case the spike verified.
 */
export function deviceNameFromUserAgent(ua: string | null): string {
  const agent = ua ?? '';
  // iPadOS 13+ often sends a Macintosh UA. "Mobile" with Macintosh is an iPad.
  const device = /iPhone/.test(agent) ? 'iPhone'
    : /iPad/.test(agent) || (/Macintosh/.test(agent) && /Mobile/.test(agent)) ? 'iPad'
    : /Android/.test(agent) ? 'Android'
    : /CrOS/.test(agent) ? 'Chromebook'
    : /Macintosh|Mac OS X/.test(agent) ? 'Mac'
    : /Windows/.test(agent) ? 'Windows'
    : /Linux/.test(agent) ? 'Linux'
    : 'Browser';
  const browser = /EdgiOS\//.test(agent) ? 'Edge'
    : /EdgA\//.test(agent) ? 'Edge'
    : /Edg\//.test(agent) ? 'Edge'
    : /CriOS\//.test(agent) ? 'Chrome'
    : /FxiOS\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Safari\//.test(agent) ? 'Safari'
    : 'browser';
  return `${device} · ${browser}`;
}

/**
 * Hidden characters a device name must not contain. U+200D (ZWJ) is allowed
 * so an emoji sequence such as "👨‍💻 laptop" is a valid name.
 * Cc, bidi controls, zero-width / invisible characters, and line separators.
 */
const HIDDEN_NAME_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u2028\u2029]/u;

/** Null when the name is empty, too long, or contains a hidden character. */
export function normalizeDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length < 1 || name.length > SESSION_NAME_MAX) return null;
  if (HIDDEN_NAME_CHARS.test(name)) return null;
  return name;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session row is missing ${field}`);
  }
  return value;
}

function asDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`session row has an unreadable ${field}`);
}

function asKind(value: unknown): SessionKind {
  if (value === 'browser' || value === 'paired_device') return value;
  throw new Error('session row has an unknown kind');
}

function asName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('session row has an unreadable name');
  return value;
}

/**
 * Mint a session, persist it, and mirror it into the in-memory store.
 * The caller sets the cookie. The plaintext token is never written down.
 */
export async function issueSession(
  pool: SessionQueryable,
  sessions: SessionStore,
  input: { kind: SessionKind; name: string; userAgent: string | null; now?: number },
): Promise<IssuedSession> {
  const now = input.now ?? Date.now();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now + SESSION_IDLE_TTL_MS);
  const seenAt = new Date(now);
  const result = await pool.query(
    `INSERT INTO sessions (token_hash, last_seen_at, expires_at, kind, name, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (token_hash) DO UPDATE
       SET expires_at = EXCLUDED.expires_at,
           last_seen_at = EXCLUDED.last_seen_at,
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           user_agent = EXCLUDED.user_agent
     RETURNING id`,
    [tokenHash, seenAt, expiresAt, input.kind, input.name, input.userAgent],
  );
  const row = result.rows[0];
  const id = asString(row?.['id'], 'id');
  sessions.set(tokenHash, { id, expiresAt: expiresAt.getTime(), renewedAt: now });
  return { id, token, tokenHash, expiresAt };
}

/** Reload unexpired sessions after a process restart. Returns how many were loaded. */
export async function loadActiveSessions(
  pool: SessionQueryable,
  sessions: SessionStore,
): Promise<number> {
  const result = await pool.query(
    `SELECT id, token_hash, expires_at, last_seen_at
     FROM sessions
     WHERE expires_at > NOW()`,
  );
  for (const row of result.rows) {
    const tokenHash = asString(row['token_hash'], 'token_hash');
    const expiresAt = asDate(row['expires_at'], 'expires_at');
    const lastSeenAt = asDate(row['last_seen_at'], 'last_seen_at');
    sessions.set(tokenHash, {
      id: asString(row['id'], 'id'),
      expiresAt: expiresAt.getTime(),
      renewedAt: lastSeenAt.getTime(),
    });
  }
  return result.rows.length;
}

export async function findSessionByTokenHash(
  pool: SessionQueryable,
  tokenHash: string,
): Promise<{ id: string; kind: SessionKind; name: string | null } | null> {
  const result = await pool.query(
    `SELECT id, kind, name
     FROM sessions
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row['id'], 'id'),
    kind: asKind(row['kind']),
    name: asName(row['name']),
  };
}

export async function listDeviceSessions(pool: SessionQueryable): Promise<DeviceSession[]> {
  const result = await pool.query(
    `SELECT id, kind, name, user_agent, created_at, last_seen_at, expires_at
     FROM sessions
     WHERE expires_at > NOW()
     ORDER BY last_seen_at DESC`,
  );
  return result.rows.map((row) => ({
    id: asString(row['id'], 'id'),
    kind: asKind(row['kind']),
    name: asName(row['name']),
    userAgent: asName(row['user_agent']),
    createdAt: asDate(row['created_at'], 'created_at').toISOString(),
    lastSeenAt: asDate(row['last_seen_at'], 'last_seen_at').toISOString(),
    expiresAt: asDate(row['expires_at'], 'expires_at').toISOString(),
    notificationsEnabled: false,
  }));
}

export async function renameSession(
  pool: SessionQueryable,
  id: string,
  name: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE sessions SET name = $2 WHERE id = $1 AND expires_at > NOW()`,
    [id, name],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface RemovedSession {
  id: string;
  tokenHash: string;
  kind: SessionKind;
  name: string | null;
}

export async function findSessionById(
  pool: SessionQueryable,
  id: string,
): Promise<RemovedSession | null> {
  const result = await pool.query(
    `SELECT id, token_hash, kind, name
     FROM sessions
     WHERE id = $1 AND expires_at > NOW()`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return rowToRemoved(row);
}

export async function deleteSession(
  pool: SessionQueryable,
  id: string,
): Promise<RemovedSession | null> {
  const result = await pool.query(
    `DELETE FROM sessions
     WHERE id = $1
     RETURNING id, token_hash, kind, name`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return rowToRemoved(row);
}

/**
 * Live sessions other than `spareTokenHash`. Pass null to select every live
 * session, which is how a bootstrap-secret caller cuts off old browsers after
 * rotating the access key. Does not delete — the route audits, then deletes.
 */
export async function selectOtherSessions(
  pool: SessionQueryable,
  spareTokenHash: string | null,
): Promise<RemovedSession[]> {
  const result = await pool.query(
    `SELECT id, token_hash, kind, name
     FROM sessions
     WHERE expires_at > NOW()
       AND ($1::text IS NULL OR token_hash <> $1)`,
    [spareTokenHash],
  );
  return result.rows.map(rowToRemoved);
}

export async function deleteSessionsByIds(
  pool: SessionQueryable,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `DELETE FROM sessions WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

function rowToRemoved(row: Record<string, unknown>): RemovedSession {
  return {
    id: asString(row['id'], 'id'),
    tokenHash: asString(row['token_hash'], 'token_hash'),
    kind: asKind(row['kind']),
    name: asName(row['name']),
  };
}

export function evictTokenHashes(sessions: SessionStore, tokenHashes: readonly string[]): void {
  for (const tokenHash of tokenHashes) sessions.delete(tokenHash);
}

/**
 * True when this touch should write. Exported so the throttle rule has a
 * direct test that does not depend on the database.
 */
export function sessionNeedsRenewal(entry: SessionEntry, now: number): boolean {
  return now - entry.renewedAt >= SESSION_RENEW_INTERVAL_MS;
}

export class SessionKeeper {
  private readonly pool: SessionQueryable;
  private readonly sessions: SessionStore;
  private readonly secureCookies: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(opts: {
    pool: SessionQueryable;
    sessions: SessionStore;
    secureCookies: boolean;
    logger: Logger;
    now?: () => number;
  }) {
    this.pool = opts.pool;
    this.sessions = opts.sessions;
    this.secureCookies = opts.secureCookies;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Slide the idle window if the last write is older than an hour.
   * The claim is synchronous, so N requests in the same hour share one write.
   * A missing name or user agent is filled from this request; a name the
   * operator set is left alone.
   */
  touch(tokenHash: string, rawToken: string, reply: FastifyReply, userAgent?: string | null): void {
    const current = this.sessions.get(tokenHash);
    if (!current) return;
    const now = this.now();
    if (!sessionNeedsRenewal(current, now)) return;

    const expiresAt = now + SESSION_IDLE_TTL_MS;
    const claimed: SessionEntry = { ...current, expiresAt, renewedAt: now };
    this.sessions.set(tokenHash, claimed);
    reply.setCookie('curia_session', rawToken, sessionCookieOptions(this.secureCookies));

    const ua = typeof userAgent === 'string' && userAgent.trim().length > 0
      ? userAgent.trim().slice(0, USER_AGENT_MAX)
      : null;
    const label = ua ? deviceNameFromUserAgent(ua) : null;
    void this.pool.query(
      `UPDATE sessions
       SET expires_at = $2,
           last_seen_at = $3,
           name = COALESCE(name, $4),
           user_agent = COALESCE(user_agent, $5)
       WHERE token_hash = $1`,
      [tokenHash, new Date(expiresAt), new Date(now), label, ua],
    ).then((result) => {
      if ((result.rowCount ?? 1) === 0) {
        // The row is gone (revoked on another path). Drop the map entry too.
        const latest = this.sessions.get(tokenHash);
        if (latest?.renewedAt === now) this.sessions.delete(tokenHash);
      }
    }).catch((err: unknown) => {
      this.logger.error({ err }, 'Session renewal write failed');
      const latest = this.sessions.get(tokenHash);
      if (latest?.renewedAt === now) this.sessions.set(tokenHash, current);
    });
  }
}

// pairing.ts — single-use phone pairing codes (#2341, ADR-055).
//
// The desktop mints a code. The QR encodes `https://<origin>/pair#c=<token>` so
// the token stays in the fragment and never reaches a proxy log. A short code
// is the typed fallback. Each credential redeems once. After the token is
// redeemed, the short code's remaining life is capped at two minutes. The
// resulting session lives only in the cookie.

import { randomBytes } from 'node:crypto';
import { PHONE_DOCS_URL } from '../../phone/phone-docs.js';
import { hashToken } from './session-auth.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet: no 0/O or 1/I. 32 symbols, so a random byte is uniform. */
const SHORT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** One trailing label. `.example` matches `my.example` and not `curia.example.com`. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.home.arpa',
  '.internal',
  '.intranet',
  '.corp',
  '.localdomain',
  '.localhost',
  '.test',
  '.example',
  '.invalid',
];

const INSTALL_WARNING =
  "This address can't install the phone app. Notifications and the home-screen icon need HTTPS on a real hostname. Curia still opens in the phone's browser. "
  + PHONE_DOCS_URL;

export interface PairingQueryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface PairOriginChoice {
  origin: string | null;
  warning: string | null;
  /** The default origin cannot host the app, so the operator must supply one. */
  askForOrigin: boolean;
}

export interface MintedPairingCode {
  id: string;
  pairUrl: string;
  shortCode: string;
  expiresAt: string;
  warning: string | null;
}

export interface ConsumedPairingCode {
  id: string;
  origin: string;
  /** The other credential on this row was already redeemed. */
  otherAlreadyRedeemed: boolean;
}

export interface PairingCodeStatus {
  tokenRedeemed: boolean;
  shortRedeemed: boolean;
  expired: boolean;
  deviceName: string | null;
}

function cleanOrigin(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url.origin;
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(':');
}

function hasPrivateSuffix(host: string): boolean {
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
}

/**
 * Why this origin cannot be the installed app, or null when it can.
 * HTTP, localhost, an IP, a single-label name, and the private suffixes
 * above all warn. One trailing dot is ignored so `localhost.` still warns
 * and `curia.example.com.` does not.
 */
export function installabilityWarning(origin: string): string | null {
  const cleaned = cleanOrigin(origin);
  if (!cleaned) return 'That address is not a usable origin.';
  const url = new URL(cleaned);
  let host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const badProtocol = url.protocol !== 'https:';
  const localhost = host === 'localhost' || host === '::1';
  const bareName = !host.includes('.') || hasPrivateSuffix(host);
  if (badProtocol || localhost || isIpLiteral(host) || bareName) return INSTALL_WARNING;
  return null;
}

/** Pick the origin encoded in the QR. An explicit request always wins. */
export function choosePairOrigin(input: {
  requested?: string | null;
  desktopOrigin?: string | null;
  appOrigin?: string | null;
}): PairOriginChoice {
  const requested = cleanOrigin(input.requested);
  if (requested) {
    return { origin: requested, warning: installabilityWarning(requested), askForOrigin: false };
  }
  const desktop = cleanOrigin(input.desktopOrigin);
  const app = cleanOrigin(input.appOrigin);
  if (desktop && installabilityWarning(desktop) === null) {
    return { origin: desktop, warning: null, askForOrigin: false };
  }
  if (app && installabilityWarning(app) === null) {
    return { origin: app, warning: null, askForOrigin: false };
  }
  const fallback = desktop ?? app;
  if (!fallback) return { origin: null, warning: null, askForOrigin: true };
  return { origin: fallback, warning: installabilityWarning(fallback), askForOrigin: true };
}

/** The token is the fragment. Nothing sensitive is placed in the query string. */
export function pairingUrl(origin: string, token: string): string {
  const base = cleanOrigin(origin);
  if (!base) throw new Error('pairing URL requires an http(s) origin');
  return `${base}/pair#c=${encodeURIComponent(token)}`;
}

export function randomShortCode(nextBytes: (size: number) => Buffer = randomBytes): string {
  let out = '';
  while (out.length < 8) {
    const buf = nextBytes(8);
    for (const byte of buf) {
      out += SHORT_ALPHABET[byte % SHORT_ALPHABET.length];
      if (out.length === 8) break;
    }
  }
  return out;
}

export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Null unless the value is exactly one short code, dashes and spaces ignored. */
export function normalizeShortCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) return null;
  return code;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pairing row is missing ${field}`);
  }
  return value;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

export async function mintPairingCode(
  pool: PairingQueryable,
  origin: string,
  now = Date.now(),
): Promise<MintedPairingCode> {
  const cleaned = cleanOrigin(origin);
  if (!cleaned) throw new Error('refusing to mint a pairing code for an unusable origin');
  await pool.query(`DELETE FROM pairing_codes WHERE expires_at < NOW()`);
  const expiresAt = new Date(now + PAIRING_TTL_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomBytes(32).toString('base64url');
    const shortCode = randomShortCode();
    try {
      const inserted = await pool.query(
        `INSERT INTO pairing_codes (token_hash, short_code_hash, origin, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [hashToken(token), hashToken(shortCode), cleaned, expiresAt],
      );
      return {
        id: asString(inserted.rows[0]?.['id'], 'id'),
        pairUrl: pairingUrl(cleaned, token),
        shortCode: formatShortCode(shortCode),
        expiresAt: expiresAt.toISOString(),
        warning: installabilityWarning(cleaned),
      };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 1) throw err;
    }
  }
  throw new Error('pairing code mint failed');
}

export type PairingCredential = { kind: 'token'; token: string } | { kind: 'short'; code: string };

const CONSUME_TOKEN_SQL = `UPDATE pairing_codes
     SET token_redeemed_at = NOW(),
         expires_at = LEAST(expires_at, NOW() + interval '2 minutes'),
         redeemed_device_name = $2
     WHERE token_hash = $1
       AND token_redeemed_at IS NULL
       AND expires_at > NOW()
     RETURNING id, origin, short_redeemed_at`;

const CONSUME_SHORT_SQL = `UPDATE pairing_codes
     SET short_redeemed_at = NOW(),
         redeemed_device_name = $2
     WHERE short_code_hash = $1
       AND short_redeemed_at IS NULL
       AND expires_at > NOW()
     RETURNING id, origin, token_redeemed_at`;

/**
 * Mark one credential used. The token path also caps the row's remaining
 * life at two minutes, so the short code cannot sit unused for the rest of
 * the original ten. The other credential stays valid until it is used or
 * that deadline passes.
 */
export async function consumePairingCode(
  pool: PairingQueryable,
  credential: PairingCredential,
  deviceName: string | null,
): Promise<ConsumedPairingCode | null> {
  const secret = credential.kind === 'token' ? credential.token : credential.code;
  const result = await pool.query(
    credential.kind === 'token' ? CONSUME_TOKEN_SQL : CONSUME_SHORT_SQL,
    [hashToken(secret), deviceName],
  );
  const row = result.rows[0];
  if (!row) return null;
  const otherColumn = credential.kind === 'token' ? 'short_redeemed_at' : 'token_redeemed_at';
  return {
    id: asString(row['id'], 'id'),
    origin: asString(row['origin'], 'origin'),
    otherAlreadyRedeemed: row[otherColumn] != null,
  };
}

const RELEASE_TOKEN_SQL = `UPDATE pairing_codes SET token_redeemed_at = NULL WHERE id = $1`;
const RELEASE_SHORT_SQL = `UPDATE pairing_codes SET short_redeemed_at = NULL WHERE id = $1`;

export async function releasePairingCode(
  pool: PairingQueryable,
  id: string,
  kind: PairingCredential['kind'],
): Promise<void> {
  await pool.query(kind === 'token' ? RELEASE_TOKEN_SQL : RELEASE_SHORT_SQL, [id]);
}

export async function readPairingCodeStatus(
  pool: PairingQueryable,
  id: string,
): Promise<PairingCodeStatus | null> {
  const result = await pool.query(
    `SELECT
       (token_redeemed_at IS NOT NULL) AS token_redeemed,
       (short_redeemed_at IS NOT NULL) AS short_redeemed,
       (expires_at <= NOW()) AS expired,
       redeemed_device_name
     FROM pairing_codes
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const deviceName = row['redeemed_device_name'];
  return {
    tokenRedeemed: row['token_redeemed'] === true,
    shortRedeemed: row['short_redeemed'] === true,
    expired: row['expired'] === true,
    deviceName: typeof deviceName === 'string' && deviceName.length > 0 ? deviceName : null,
  };
}

// pairing.ts — single-use phone pairing codes (#2341, ADR-055).
//
// The desktop mints a code. The QR encodes `https://<origin>/pair#c=<token>` so
// the token stays in the fragment and never reaches a proxy log. A short code
// is the typed fallback. Each credential redeems once, within 10 minutes, and
// the resulting session lives only in the cookie.

import { randomBytes } from 'node:crypto';
import { hashToken } from './session-auth.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Unambiguous alphabet: no 0/O or 1/I. 32 symbols, so a random byte is uniform. */
const SHORT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const INSTALL_WARNING =
  "This address can't install the phone app. Notifications and the home-screen icon need HTTPS on a real hostname. Curia still opens in the phone's browser.";

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

/**
 * Why this origin cannot be the installed app, or null when it can.
 * A bare IP, localhost, a single-label name, `.local`, and plain HTTP all warn.
 */
export function installabilityWarning(origin: string): string | null {
  const cleaned = cleanOrigin(origin);
  if (!cleaned) return 'That address is not a usable origin.';
  const url = new URL(cleaned);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const badProtocol = url.protocol !== 'https:';
  const localhost = host === 'localhost' || host.endsWith('.localhost') || host === '::1';
  const bareName = !host.includes('.') || host.endsWith('.local');
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

export function readFragmentToken(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(raw).get('c');
  if (!token || !/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  return token;
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

/**
 * Mark one credential used. The other credential on the same row stays valid
 * until it is used or the row expires, so a typed code still works when the
 * browser cookie did not carry into the installed app.
 */
export async function consumePairingCode(
  pool: PairingQueryable,
  credential: PairingCredential,
): Promise<{ id: string; origin: string } | null> {
  const redeemedColumn = credential.kind === 'token' ? 'token_redeemed_at' : 'short_redeemed_at';
  const hashColumn = credential.kind === 'token' ? 'token_hash' : 'short_code_hash';
  const secret = credential.kind === 'token' ? credential.token : credential.code;
  const result = await pool.query(
    `UPDATE pairing_codes
     SET ${redeemedColumn} = NOW()
     WHERE ${hashColumn} = $1
       AND ${redeemedColumn} IS NULL
       AND expires_at > NOW()
     RETURNING id, origin`,
    [hashToken(secret)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: asString(row['id'], 'id'), origin: asString(row['origin'], 'origin') };
}

export async function releasePairingCode(
  pool: PairingQueryable,
  id: string,
  kind: PairingCredential['kind'],
): Promise<void> {
  const redeemedColumn = kind === 'token' ? 'token_redeemed_at' : 'short_redeemed_at';
  await pool.query(
    `UPDATE pairing_codes SET ${redeemedColumn} = NULL WHERE id = $1`,
    [id],
  );
}

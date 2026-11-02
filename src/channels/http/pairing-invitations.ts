// pairing-invitations.ts — the phone app invitation link (#2412, ADR-055 amendment of 2026-11-02).
//
// The operator mints a link for the principal and sends it through their own
// channel. It uses the QR link's shape, `https://<origin>/pair#c=<token>`, so
// the phone's pair page and /api/pairing/redeem need nothing new, and the
// token stays in the fragment. It differs from a QR code in three ways:
//
// - it lasts 48 hours, not 10 minutes, because it waits to be opened;
// - it is one credential with no short code, so there is no second
//   credential to cap after redemption;
// - at most one is current. Minting a new link supersedes the old one, and a
//   superseded link no longer redeems.

import { randomBytes } from 'node:crypto';
import { hashToken } from './session-auth.js';
import { cleanOrigin, installabilityWarning, pairingUrl, type PairingQueryable } from './pairing.js';

export const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

/** Rows that are no longer current are kept this long for the audit trail. */
const PRUNE_AFTER = '7 days';

export interface MintedInvitation {
  id: string;
  pairUrl: string;
  expiresAt: string;
  warning: string | null;
}

export type InvitationState = 'waiting' | 'redeemed' | 'expired';

export interface InvitationStatus {
  id: string;
  state: InvitationState;
  expiresAt: string;
  redeemedAt: string | null;
  deviceName: string | null;
}

export interface ConsumedInvitation {
  id: string;
  origin: string;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

function asIso(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) return new Date(value).toISOString();
  throw new Error(`pairing invitation row is missing ${field}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pairing invitation row is missing ${field}`);
  }
  return value;
}

const SUPERSEDE_SQL = `UPDATE pairing_invitations
     SET superseded_at = NOW()
     WHERE superseded_at IS NULL
     RETURNING id`;

const INSERT_SQL = `INSERT INTO pairing_invitations (token_hash, origin, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`;

/**
 * Mint the current invitation. The previous one stops redeeming before the
 * new one exists. Two mints racing can both supersede and then both insert;
 * the partial unique index rejects the second insert, and its retry
 * supersedes the winner, so the later mint is the one that stays current.
 */
export async function mintInvitation(
  pool: PairingQueryable,
  origin: string,
  now = Date.now(),
): Promise<MintedInvitation> {
  const cleaned = cleanOrigin(origin);
  if (!cleaned) throw new Error('refusing to mint an invitation for an unusable origin');
  await pool.query(
    `DELETE FROM pairing_invitations WHERE superseded_at < NOW() - $1::interval`,
    [PRUNE_AFTER],
  );
  const expiresAt = new Date(now + INVITATION_TTL_MS);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomBytes(32).toString('base64url');
    try {
      await pool.query(SUPERSEDE_SQL);
      const inserted = await pool.query(INSERT_SQL, [hashToken(token), cleaned, expiresAt]);
      return {
        id: asString(inserted.rows[0]?.['id'], 'id'),
        pairUrl: pairingUrl(cleaned, token),
        expiresAt: expiresAt.toISOString(),
        warning: installabilityWarning(cleaned),
      };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 2) throw err;
    }
  }
  throw new Error('pairing invitation mint failed');
}

const STOP_BY_ID_SQL = `UPDATE pairing_invitations
     SET superseded_at = NOW()
     WHERE id = $1 AND superseded_at IS NULL
     RETURNING id`;

/** Stop one invitation by id. A newer current invitation is left alone. */
export async function stopInvitation(pool: PairingQueryable, id: string): Promise<boolean> {
  const result = await pool.query(STOP_BY_ID_SQL, [id]);
  return result.rows.length > 0;
}

/** Stop the current invitation without minting another. True when one was live. */
export async function cancelInvitation(pool: PairingQueryable): Promise<boolean> {
  const result = await pool.query(SUPERSEDE_SQL);
  return result.rows.length > 0;
}

/**
 * Mark the invitation used. Only the current, unexpired, unredeemed row
 * matches, so a replay, a superseded link and an expired link all get null.
 */
export async function consumeInvitation(
  pool: PairingQueryable,
  token: string,
  deviceName: string | null,
): Promise<ConsumedInvitation | null> {
  const result = await pool.query(
    `UPDATE pairing_invitations
     SET redeemed_at = NOW(), device_name = $2
     WHERE token_hash = $1
       AND redeemed_at IS NULL
       AND superseded_at IS NULL
       AND expires_at > NOW()
     RETURNING id, origin`,
    [hashToken(token), deviceName],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: asString(row['id'], 'id'), origin: asString(row['origin'], 'origin') };
}

/** Undo a redemption whose session or audit failed, so the link still works. */
export async function releaseInvitation(pool: PairingQueryable, id: string): Promise<void> {
  await pool.query(
    `UPDATE pairing_invitations SET redeemed_at = NULL, device_name = NULL WHERE id = $1`,
    [id],
  );
}

/** The current invitation, or null when none was minted or the last was cancelled. */
export async function readCurrentInvitation(pool: PairingQueryable): Promise<InvitationStatus | null> {
  const result = await pool.query(
    `SELECT id, expires_at, redeemed_at, device_name, (expires_at <= NOW()) AS expired
     FROM pairing_invitations
     WHERE superseded_at IS NULL
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const redeemedAt = row['redeemed_at'] == null ? null : asIso(row['redeemed_at'], 'redeemed_at');
  const state: InvitationState = redeemedAt ? 'redeemed' : row['expired'] === true ? 'expired' : 'waiting';
  const name = row['device_name'];
  return {
    id: asString(row['id'], 'id'),
    state,
    expiresAt: asIso(row['expires_at'], 'expires_at'),
    redeemedAt,
    deviceName: typeof name === 'string' && name.length > 0 ? name : null,
  };
}

/**
 * Tell every signed-in device that an invitation was used. The phone that
 * just paired is the subject, so its own banner leaves the notice out.
 */
export async function recordPairedNotice(
  pool: PairingQueryable,
  sessionId: string,
  deviceName: string | null,
): Promise<void> {
  const device = deviceName ? `: ${deviceName}` : '';
  const detail = `A phone signed in with your invitation link${device}. If you didn't expect that, sign it out under Settings → Devices.`;
  await pool.query(
    `INSERT INTO push_notices (kind, detail, subject_session_id) VALUES ('paired', $1, $2)`,
    [detail.slice(0, 300), sessionId],
  );
}

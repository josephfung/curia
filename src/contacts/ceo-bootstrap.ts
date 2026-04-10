// src/contacts/ceo-bootstrap.ts
//
// CEO contact bootstrap.
//
// Ensures the CEO's primary email is linked to a confirmed, verified contact
// before the email adapter starts polling. Without this, the first inbound email
// from the CEO triggers auto-creation via extractParticipants(), which always
// creates contacts as provisional — causing their messages to be held.
//
// This module is called once at startup. It is idempotent under serial execution
// (safe for single-process deployments, consistent with the migration runner).
// Handles three cases:
//   1. Contact + identity already exist as confirmed/verified → no-op
//   2. Contact + identity exist as provisional/unverified → promote in-place
//   3. Neither exists → create fresh contact + identity (in a transaction)

import { randomUUID } from 'crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

export interface CeoContactBootstrapResult {
  contactId: string;
  /** true if the contact already existed (possibly promoted), false if newly created */
  alreadyExisted: boolean;
}

/**
 * Ensure the CEO's primary email contact exists and is confirmed + verified.
 *
 * @param ceoPrimaryEmail  The CEO's primary email address (from CEO_PRIMARY_EMAIL env)
 * @param displayName      Display name to use if creating a new contact (defaults to "CEO")
 * @param pool             Postgres connection pool
 * @param logger           Pino logger
 */
export async function bootstrapCeoContact(
  ceoPrimaryEmail: string,
  displayName: string,
  pool: DbPool,
  logger: Logger,
): Promise<CeoContactBootstrapResult> {
  // Look up by channel identity first — this is the authoritative key for email senders.
  const existing = await pool.query<{ contact_id: string; contact_status: string; identity_verified: boolean }>(
    `SELECT ci.contact_id, c.status AS contact_status, ci.verified AS identity_verified
     FROM contact_channel_identities ci
     JOIN contacts c ON c.id = ci.contact_id
     WHERE ci.channel = 'email' AND ci.channel_identifier = $1`,
    [ceoPrimaryEmail],
  );

  if (existing.rows[0]) {
    const { contact_id, contact_status, identity_verified } = existing.rows[0];

    // Always ensure role = 'ceo' and trust_level = 'high' on the CEO contact regardless
    // of which path brought us here. This is idempotent — the UPDATE is a no-op when both
    // are already correct. Without trust_level = 'high', a second CEO email address linked
    // to the same contact would not match the single CEO_PRIMARY_EMAIL config string and
    // would fail the outbound filter's trust check. Setting role keeps metadata consistent
    // even if the contact was initially auto-created without a role.
    await pool.query(
      `UPDATE contacts
       SET role = 'ceo',
           trust_level = 'high',
           updated_at = now()
       WHERE id = $1
         AND (role IS DISTINCT FROM 'ceo' OR trust_level IS DISTINCT FROM 'high')`,
      [contact_id],
    );

    // Already confirmed + verified — nothing else to do.
    if (contact_status === 'confirmed' && identity_verified) {
      logger.info({ contactId: contact_id, email: ceoPrimaryEmail }, 'ceo-bootstrap: CEO contact already confirmed and verified');
      return { contactId: contact_id, alreadyExisted: true };
    }

    // Promote in-place: update contact status and/or identity verified flag.
    // Two separate updates so each is independently auditable.
    if (contact_status !== 'confirmed') {
      await pool.query(
        `UPDATE contacts SET status = 'confirmed', updated_at = now() WHERE id = $1`,
        [contact_id],
      );
    }
    if (!identity_verified) {
      await pool.query(
        `UPDATE contact_channel_identities
         SET verified = true, verified_at = now(), updated_at = now()
         WHERE channel = 'email' AND channel_identifier = $1`,
        [ceoPrimaryEmail],
      );
    }

    logger.info(
      { contactId: contact_id, email: ceoPrimaryEmail, wasStatus: contact_status, wasVerified: identity_verified },
      'ceo-bootstrap: CEO contact promoted to confirmed + verified',
    );
    return { contactId: contact_id, alreadyExisted: true };
  }

  // No existing record — create contact and link the email identity in a single
  // transaction so a partial failure cannot leave an orphaned contacts row.
  //
  // If two instances start simultaneously and both reach this point, one will win
  // and the other will hit a 23505 unique constraint violation on channel_identifier.
  // In that case we re-query for the winning row and return it as-is — the CEO contact
  // exists and is correct, so this is an idempotent success, not an error.
  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO contacts (id, display_name, role, status, trust_level, created_at, updated_at)
       VALUES ($1, $2, 'ceo', 'confirmed', 'high', now(), now())`,
      [contactId, displayName],
    );
    await client.query(
      `INSERT INTO contact_channel_identities
         (id, contact_id, channel, channel_identifier, verified, verified_at, source, created_at, updated_at)
       VALUES ($1, $2, 'email', $3, true, now(), 'bootstrap', now(), now())`,
      [randomUUID(), contactId, ceoPrimaryEmail],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // 23505 = unique_violation: another instance won the race and already created the
    // identity. Re-query for the winning row and treat as idempotent success.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      const winner = await pool.query<{ contact_id: string }>(
        `SELECT contact_id FROM contact_channel_identities
         WHERE channel = 'email' AND channel_identifier = $1`,
        [ceoPrimaryEmail],
      );
      if (winner.rows[0]) {
        logger.info({ contactId: winner.rows[0].contact_id, email: ceoPrimaryEmail }, 'ceo-bootstrap: concurrent startup race resolved — existing CEO contact used');
        return { contactId: winner.rows[0].contact_id, alreadyExisted: true };
      }
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info({ contactId, email: ceoPrimaryEmail }, 'ceo-bootstrap: CEO contact created');
  return { contactId, alreadyExisted: false };
}

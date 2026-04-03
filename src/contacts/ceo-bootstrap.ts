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

    // Already confirmed + verified — nothing to do.
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
  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO contacts (id, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, 'ceo', 'confirmed', now(), now())`,
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
    throw err;
  } finally {
    client.release();
  }

  logger.info({ contactId, email: ceoPrimaryEmail }, 'ceo-bootstrap: CEO contact created');
  return { contactId, alreadyExisted: false };
}

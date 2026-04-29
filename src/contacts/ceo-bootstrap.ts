// src/contacts/ceo-bootstrap.ts
//
// CEO contact bootstrap.
//
// Ensures the CEO's primary email is linked to a confirmed, verified contact
// before the email adapter starts polling. Without this, the first inbound email
// from the CEO triggers auto-creation via extractParticipants(), which always
// creates contacts as provisional — causing their messages to be held.
//
// Also ensures the CEO contact has a KG person node (kg_node_id). Without one,
// entity context enrichment is non-functional for the CEO: no facts, standing
// instructions, or relationship data can be stored or retrieved. See issue #380.
//
// This module is called once at startup. It is idempotent under serial execution
// (safe for single-process deployments, consistent with the migration runner).
// Handles three cases:
//   1. Contact + identity already exist as confirmed/verified → ensure kg_node_id, no-op otherwise
//   2. Contact + identity exist as provisional/unverified → promote in-place, ensure kg_node_id
//   3. Neither exists → create KG node, then create contact + identity in a transaction

import { randomUUID } from 'crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

export interface CeoContactBootstrapResult {
  contactId: string;
  kgNodeId: string;
  /** true if the contact already existed (possibly promoted), false if newly created */
  alreadyExisted: boolean;
}

/**
 * Ensure the CEO's primary email contact exists, is confirmed + verified, and has a
 * linked KG person node.
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
  // Also fetch kg_node_id and display_name so we can detect and fix the missing-KG-node case.
  const existing = await pool.query<{
    contact_id: string;
    contact_status: string;
    identity_verified: boolean;
    kg_node_id: string | null;
    display_name: string;
  }>(
    `SELECT ci.contact_id,
            c.status        AS contact_status,
            ci.verified     AS identity_verified,
            c.kg_node_id,
            c.display_name
     FROM contact_channel_identities ci
     JOIN contacts c ON c.id = ci.contact_id
     WHERE ci.channel = 'email' AND ci.channel_identifier = $1`,
    [ceoPrimaryEmail],
  );

  if (existing.rows[0]) {
    const { contact_id, contact_status, identity_verified, display_name: existingName } = existing.rows[0];
    let { kg_node_id } = existing.rows[0];

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

    // Backfill KG node if missing. This handles existing deployments where the contact
    // was created without a KG node (pre-#380 fix). Uses the contact's existing display_name
    // rather than the passed-in default so we don't overwrite a name that was already set.
    if (!kg_node_id) {
      kg_node_id = await createAndLinkKgNode(contact_id, existingName, pool);
      logger.info(
        { contactId: contact_id, kgNodeId: kg_node_id, email: ceoPrimaryEmail },
        'ceo-bootstrap: backfilled KG person node for existing CEO contact',
      );
    }

    // Already confirmed + verified — nothing else to do.
    if (contact_status === 'confirmed' && identity_verified) {
      logger.info({ contactId: contact_id, kgNodeId: kg_node_id, email: ceoPrimaryEmail }, 'ceo-bootstrap: CEO contact already confirmed and verified');
      return { contactId: contact_id, kgNodeId: kg_node_id, alreadyExisted: true };
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
      { contactId: contact_id, kgNodeId: kg_node_id, email: ceoPrimaryEmail, wasStatus: contact_status, wasVerified: identity_verified },
      'ceo-bootstrap: CEO contact promoted to confirmed + verified',
    );
    return { contactId: contact_id, kgNodeId: kg_node_id, alreadyExisted: true };
  }

  // No existing record — create the KG person node first, then create the contact and
  // channel identity in a single transaction so a partial failure cannot leave an orphaned
  // contacts row. The KG node is created outside the transaction intentionally: if the
  // transaction fails with 23505 (concurrent startup race), we rescue the orphaned KG node
  // by linking it to the winning contact (see below).
  //
  // Note: creating the KG node before the transaction means a failed transaction leaves an
  // unlinked kg_nodes row. This is acceptable for single-process deployments — next startup
  // will find the contact (via the winning process) and take the existing-contact path above.
  const kgNodeId = await insertKgPersonNode(displayName, pool);

  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO contacts (id, kg_node_id, display_name, role, status, trust_level, created_at, updated_at)
       VALUES ($1, $2, $3, 'ceo', 'confirmed', 'high', now(), now())`,
      [contactId, kgNodeId, displayName],
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
    // We also rescue the KG node we created above by linking it to the winner's contact
    // if the winner ran old code and has no kg_node_id yet.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      const winner = await pool.query<{ contact_id: string; kg_node_id: string | null }>(
        `SELECT c.id AS contact_id, c.kg_node_id
         FROM contact_channel_identities ci
         JOIN contacts c ON c.id = ci.contact_id
         WHERE ci.channel = 'email' AND ci.channel_identifier = $1`,
        [ceoPrimaryEmail],
      );
      if (winner.rows[0]) {
        const winnerContactId = winner.rows[0].contact_id;
        let winnerKgNodeId = winner.rows[0].kg_node_id;
        if (!winnerKgNodeId) {
          // Winner ran old code — link the orphaned KG node we already created to them.
          await pool.query(
            `UPDATE contacts SET kg_node_id = $1, updated_at = now() WHERE id = $2 AND kg_node_id IS NULL`,
            [kgNodeId, winnerContactId],
          );
          // Re-SELECT to confirm the rescue UPDATE landed — a third concurrent process may
          // have beaten us to it, in which case the winner's kg_node_id is theirs, not ours.
          const recheck = await pool.query<{ kg_node_id: string | null }>(
            `SELECT kg_node_id FROM contacts WHERE id = $1`,
            [winnerContactId],
          );
          winnerKgNodeId = recheck.rows[0]?.kg_node_id ?? null;
          if (!winnerKgNodeId) {
            throw new Error(
              `ceo-bootstrap: winner contact ${winnerContactId} still has no kg_node_id after rescue UPDATE — inspect contacts table`,
            );
          }
        }
        logger.info({ contactId: winnerContactId, kgNodeId: winnerKgNodeId, email: ceoPrimaryEmail }, 'ceo-bootstrap: concurrent startup race resolved — existing CEO contact used');
        return { contactId: winnerContactId, kgNodeId: winnerKgNodeId, alreadyExisted: true };
      }
      // 23505 fired but the winner re-query returned no rows — the winning contact may have
      // been deleted between the violation and the re-query, or a different constraint fired.
      logger.warn(
        { pgCode, email: ceoPrimaryEmail },
        'ceo-bootstrap: 23505 unique violation but winner re-query returned no rows — re-throwing',
      );
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info({ contactId, kgNodeId, email: ceoPrimaryEmail }, 'ceo-bootstrap: CEO contact created with KG person node');
  return { contactId, kgNodeId, alreadyExisted: false };
}

/**
 * Upsert a KG person node for the CEO and return its id.
 * Uses decay_class='permanent' and confidence=1.0 to match the agent identity pattern —
 * bootstrap nodes are never decayed by the DreamEngine.
 *
 * Uses ON CONFLICT on the idx_kg_nodes_unique index (migration 016) rather than a blind
 * INSERT, because a person node with the same label may already exist — either from a
 * concurrent startup or from email-based contact extraction that ran before bootstrap.
 * Without this, a blind INSERT would 23505 outside the contact-identity recovery block
 * and propagate as an unhandled error.
 */
async function insertKgPersonNode(displayName: string, pool: DbPool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
     VALUES ('person', $1, '{}', 1.0, 'permanent', 'bootstrap', now(), now())
     ON CONFLICT (lower(label), type) WHERE type != 'fact' AND archived_at IS NULL
     DO UPDATE SET last_confirmed_at = now()
     RETURNING id`,
    [displayName],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error('ceo-bootstrap: INSERT INTO kg_nodes returned no rows or no id — check migrations 004 and 016 were applied');
  }
  return id;
}

/**
 * Create a KG person node and link it to an existing contact that has kg_node_id = NULL.
 * Returns the actual kg_node_id that ended up on the contact (which may differ from the
 * newly-created node if a concurrent process already set kg_node_id before our UPDATE).
 */
async function createAndLinkKgNode(contactId: string, displayName: string, pool: DbPool): Promise<string> {
  const newKgNodeId = await insertKgPersonNode(displayName, pool);
  await pool.query(
    `UPDATE contacts SET kg_node_id = $1, updated_at = now() WHERE id = $2 AND kg_node_id IS NULL`,
    [newKgNodeId, contactId],
  );
  // Re-select to get whichever node actually ended up linked — another process may have
  // won the race and set kg_node_id to a different value before our UPDATE fired.
  const result = await pool.query<{ kg_node_id: string }>(
    `SELECT kg_node_id FROM contacts WHERE id = $1`,
    [contactId],
  );
  if (!result.rows[0]?.kg_node_id) {
    throw new Error(`ceo-bootstrap: contact ${contactId} still has no kg_node_id after UPDATE — possible concurrent conflict`);
  }
  return result.rows[0].kg_node_id;
}

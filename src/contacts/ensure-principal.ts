// src/contacts/ensure-principal.ts
//
// Name-only principal contact creation for the in-app onboarding wizard (issue #771).
//
// Unlike bootstrapCeoContact (which is keyed on CEO_PRIMARY_EMAIL and creates an email
// channel identity at the same time), this helper takes only a display name. It exists
// so the wizard's Step 1 "About you" can create the principal as a named entity before
// any channel identity is bound. Channel identities (email, Signal) are added later via
// per-channel verification flows — see docs/wip/2026-05-10-principal-identity-design.md.
//
// Behavior:
//   1. If a contact with system_role='principal' already exists, return it. Backfill
//      kg_node_id if missing (preserving the existing display_name — we don't rename).
//   2. Otherwise create the principal contact + KG person node, mirroring the field
//      set bootstrapCeoContact uses (role='ceo', trust_level='ceo', status='confirmed').
//      No contact_channel_identities row is inserted.
//
// Idempotent under serial AND concurrent execution. Handles the 23505 race on the
// system_role partial unique index by re-querying and returning the winner.

import { randomUUID } from 'crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { insertKgPersonNode, createAndLinkKgNode } from './ceo-bootstrap.js';

export interface EnsurePrincipalOptions {
  /** Display name for the principal contact. Used only when creating; existing principals keep their stored name. */
  displayName: string;
}

export interface EnsurePrincipalResult {
  contactId: string;
  kgNodeId: string;
  /** true if the principal already existed (this call was a no-op or backfill), false if newly created */
  alreadyExisted: boolean;
}

export async function ensurePrincipalContact(
  opts: EnsurePrincipalOptions,
  pool: DbPool,
  logger: Logger,
): Promise<EnsurePrincipalResult> {
  const displayName = opts.displayName.trim();
  if (!displayName) {
    throw new Error('ensurePrincipalContact: displayName must be a non-empty string');
  }

  // 1. Existing principal? Return it (with kg_node_id backfilled if needed).
  // Look up by system_role — the canonical key, not by email or any channel identity.
  const existing = await pool.query<{
    id: string;
    display_name: string;
    kg_node_id: string | null;
  }>(
    `SELECT id, display_name, kg_node_id
     FROM contacts
     WHERE system_role = 'principal'
     LIMIT 1`,
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    let kgNodeId = row.kg_node_id;
    if (!kgNodeId) {
      // Use the EXISTING display_name for the backfilled KG node — this helper
      // does not rename principals as a side-effect of being called with a
      // different name. Renames need to go through an explicit update path.
      kgNodeId = await createAndLinkKgNode(row.id, row.display_name, pool);
      logger.info(
        { contactId: row.id, kgNodeId },
        'ensure-principal: backfilled KG person node for existing principal',
      );
    }
    return { contactId: row.id, kgNodeId, alreadyExisted: true };
  }

  // 2. Create the principal. KG node first (outside the transaction so a concurrent
  // race can rescue it onto the winner), then the contacts row in a transaction so
  // a partial failure can't leave an orphan.
  const kgNodeId = await insertKgPersonNode(displayName, pool);
  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Include tier and kind explicitly so the principal is never left at the
    // migration-055 column defaults ('unknown'/'person'). The ceo-bootstrap
    // corrective UPDATE cannot fire on this path (no channel identity yet), so
    // the correct values must be present from the moment the row is inserted.
    await client.query(
      `INSERT INTO contacts
         (id, kg_node_id, display_name, role, status, trust_level, system_role, tier, kind, created_at, updated_at)
       VALUES ($1, $2, $3, 'ceo', 'confirmed', 'ceo', 'principal', 'principal', 'principal', now(), now())`,
      [contactId, kgNodeId, displayName],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    const pgCode = (err as { code?: string }).code;
    const constraint = (err as { constraint?: string }).constraint;

    // A concurrent boot won the race and created the principal between our SELECT
    // (step 1) and our INSERT here. Re-query and adopt the winner. Also rescue
    // the orphan KG node we already inserted by linking it to the winner if they
    // somehow ended up without one (mirrors ceo-bootstrap.ts:184-214).
    if (pgCode === '23505' && constraint?.startsWith('idx_contacts_system_role_')) {
      const winner = await pool.query<{ id: string; kg_node_id: string | null }>(
        `SELECT id, kg_node_id FROM contacts WHERE system_role = 'principal' LIMIT 1`,
      );
      if (winner.rows[0]) {
        const winnerRow = winner.rows[0];
        let winnerKgNodeId = winnerRow.kg_node_id;
        if (!winnerKgNodeId) {
          await pool.query(
            `UPDATE contacts SET kg_node_id = $1, updated_at = now()
             WHERE id = $2 AND kg_node_id IS NULL`,
            [kgNodeId, winnerRow.id],
          );
          const recheck = await pool.query<{ kg_node_id: string | null }>(
            `SELECT kg_node_id FROM contacts WHERE id = $1`,
            [winnerRow.id],
          );
          winnerKgNodeId = recheck.rows[0]?.kg_node_id ?? null;
        }
        if (!winnerKgNodeId) {
          throw new Error(
            `ensure-principal: winner contact ${winnerRow.id} has no kg_node_id after rescue UPDATE — inspect contacts table`,
          );
        }
        // Loser-path orphan cleanup: if the winner already had their own kg_node_id
        // before we got here, the node we created at line 80 is now unreferenced.
        // The NOT EXISTS guard makes the delete safe under further concurrent races
        // (some other process may have linked our node to their own contact between
        // our UPDATE recheck above and this DELETE).
        if (winnerKgNodeId !== kgNodeId) {
          await pool.query(
            `DELETE FROM kg_nodes
             WHERE id = $1
               AND NOT EXISTS (SELECT 1 FROM contacts WHERE kg_node_id = $1)`,
            [kgNodeId],
          );
        }
        logger.info(
          { contactId: winnerRow.id, kgNodeId: winnerKgNodeId },
          'ensure-principal: concurrent race resolved — existing principal used',
        );
        return { contactId: winnerRow.id, kgNodeId: winnerKgNodeId, alreadyExisted: true };
      }
      logger.warn(
        { pgCode, constraint },
        'ensure-principal: 23505 on principal index but winner re-query returned no rows — re-throwing',
      );
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info({ contactId, kgNodeId }, 'ensure-principal: principal contact created (no channel identity)');
  return { contactId, kgNodeId, alreadyExisted: false };
}

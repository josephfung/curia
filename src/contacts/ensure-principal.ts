// src/contacts/ensure-principal.ts
//
// Name-only principal contact creation for the in-app onboarding wizard (issue #771).
//
// This helper takes only a display name and creates no channel identity. It exists so
// the wizard's Step 1 "About you" can create the principal as a named entity before any
// channel identity is bound. Channel identities (email, Signal) are added later via
// per-channel verification flows — see docs/wip/2026-05-10-principal-identity-design.md.
// Since #1049 this is the *only* principal-creation path (the env-var-driven CEO bootstrap
// was removed); startup resolution is read-only via findContactBySystemRole('principal').
//
// Behavior:
//   1. If a contact with system_role='principal' already exists, return it. Backfill
//      kg_node_id if missing (preserving the existing display_name — we don't rename).
//   2. Otherwise create the principal contact + KG person node with the canonical field
//      set (role='ceo', tier='principal', kind='principal', system_role='principal').
//      Legacy status/trust_level columns are not written (#955).
//      No contact_channel_identities row is inserted.
//
// Idempotent under serial AND concurrent execution. Handles the 23505 race on the
// system_role partial unique index by re-querying and returning the winner.

import { randomUUID } from 'crypto';
import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';
import { insertKgPersonNode, createAndLinkKgNode, repairPrincipalMetadata } from './ceo-bootstrap.js';

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
    // Self-heal capability metadata: an existing principal row may have been left at
    // migration-055 defaults ('unknown'/'person') by an older path; repair before returning.
    await repairPrincipalMetadata(row.id, pool, logger);
    return { contactId: row.id, kgNodeId, alreadyExisted: true };
  }

  // 2. Create the principal. KG node first (outside the transaction so a concurrent
  // race can rescue it onto the winner), then the contacts row in a transaction so
  // a partial failure can't leave an orphan.
  const { id: kgNodeId, created: kgNodeCreated } = await insertKgPersonNode(displayName, pool);
  // Adoption inherits whatever an LLM previously attached to this label and is one-way
  // (identity_source never moves back), so record which branch fired.
  logger.info(
    { kgNodeId, created: kgNodeCreated, displayName },
    kgNodeCreated
      ? 'ensure-principal: minted a new KG node for the principal'
      : 'ensure-principal: adopted an existing KG node as the principal identity',
  );
  const contactId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Include tier and kind explicitly so the principal is never left at the
    // migration-055 column defaults ('unknown'/'person'). The ceo-bootstrap
    // corrective UPDATE cannot fire on this path (no channel identity yet), so
    // the correct values must be present from the moment the row is inserted.
    // status/trust_level are legacy columns removed in #955 — not written here.
    await client.query(
      `INSERT INTO contacts
         (id, kg_node_id, display_name, role, system_role, tier, kind, created_at, updated_at)
       VALUES ($1, $2, $3, 'ceo', 'principal', 'principal', 'principal', now(), now())`,
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
        // before we got here, the node we created above is now unreferenced.
        // The NOT EXISTS guard makes the delete safe under further concurrent races
        // (some other process may have linked our node to their own contact between
        // our UPDATE recheck above and this DELETE).
        //
        // Gated on kgNodeCreated: insertKgPersonNode may have ADOPTED a pre-existing
        // extraction node rather than minting one, and that node's facts and edges are
        // not ours to delete just because we lost the principal race (ADR-040).
        if (kgNodeCreated && winnerKgNodeId !== kgNodeId) {
          await pool.query(
            `DELETE FROM kg_nodes
             WHERE id = $1
               AND NOT EXISTS (SELECT 1 FROM contacts WHERE kg_node_id = $1)`,
            [kgNodeId],
          );
        }
        // Self-heal: the race winner may be an older writer; repair tier/kind etc.
        await repairPrincipalMetadata(winnerRow.id, pool, logger);
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

    // The contacts INSERT failed and we are giving up, so the node minted above has no
    // owner. It must not be left behind: since ADR-040 it is contact-anchored, which means
    // permanent, undecayable and unarchivable, and it carries the principal's display name.
    // Every failed boot would add another, until resolveOrCreate() sees N candidates for
    // that name, returns 'ambiguous', and facts about the principal stop landing at all.
    // Before ADR-040 the old ON CONFLICT made a retry reuse the same row, so this leak is
    // new. Gated on kgNodeCreated for the usual reason — an ADOPTED node predates us.
    if (kgNodeCreated) {
      try {
        await pool.query(
          `DELETE FROM kg_nodes
            WHERE id = $1
              AND NOT EXISTS (SELECT 1 FROM contacts WHERE kg_node_id = $1)`,
          [kgNodeId],
        );
      } catch (cleanupErr) {
        // The contacts INSERT failure stays the thrown error — it is the cause, and
        // callers branch on its pgCode/constraint. The cleanup failure is attached as
        // `cause` rather than discarded, so a caller or error reporter that walks the
        // chain still sees that a permanent, undecayable node was left behind.
        logger.error(
          { cleanupErr, kgNodeId },
          'ensure-principal: could not remove the orphaned principal KG node after a failed create — '
            + 'it is anchored and will not decay; see the anchored-orphan query in scripts/kg-node-linkage-report.ts',
        );
        if (err instanceof Error && err.cause === undefined) {
          err.cause = cleanupErr;
        }
      }
    } else {
      logger.warn(
        { kgNodeId },
        'ensure-principal: adopted KG node left anchored with no contact after a failed create — '
          + 'it will not decay; see the anchored-orphan query in scripts/kg-node-linkage-report.ts',
      );
    }
    throw err;
  } finally {
    client.release();
  }

  logger.info({ contactId, kgNodeId }, 'ensure-principal: principal contact created (no channel identity)');
  return { contactId, kgNodeId, alreadyExisted: false };
}

// src/contacts/ceo-bootstrap.ts
//
// Principal contact utilities.
//
// The env-var-driven CEO bootstrap (`bootstrapCeoContact`, keyed on CEO_PRIMARY_EMAIL)
// was removed in #1049: the in-app onboarding wizard (#771) now creates the principal,
// and `findContactBySystemRole('principal')` is the single startup resolution path
// (see src/index.ts). What remains here are the shared, channel-agnostic utilities the
// wizard path (ensure-principal.ts) and the startup resolution both rely on:
//   - repairPrincipalMetadata: idempotent self-heal of role/system_role/tier/kind
//   - insertKgPersonNode / createAndLinkKgNode: KG person-node creation + linkage
//
// Legacy status/trust_level columns are not written by this module (#955).

import type { DbPool } from '../db/connection.js';
import type { Logger } from '../logger.js';

/**
 * Repair a principal/CEO contact's capability metadata to the canonical values.
 *
 * Idempotent — the WHERE guard makes it a no-op when the row is already correct.
 * Called on EVERY path that returns an existing principal row (initial bootstrap,
 * the 23505 race winner in both this module and ensure-principal), so a row left at
 * migration-055 column defaults ('unknown'/'person') — or any older downgraded value —
 * self-heals instead of persisting reduced capability for the run. (#945)
 */
export async function repairPrincipalMetadata(contactId: string, pool: DbPool, logger: Logger): Promise<void> {
  try {
    await pool.query(
      `UPDATE contacts
         SET role = 'ceo',
             system_role = 'principal',
             tier = 'principal',
             kind = 'principal',
             updated_at = now()
       WHERE id = $1
         AND (role IS DISTINCT FROM 'ceo'
           OR system_role IS DISTINCT FROM 'principal'
           OR tier IS DISTINCT FROM 'principal'
           OR kind IS DISTINCT FROM 'principal')`,
      [contactId],
    );
  } catch (err) {
    // Log with context, then propagate. A failure to apply the canonical principal
    // capability metadata means the CEO's trust gates (e.g. PII-redaction bypass)
    // may not apply, so every caller treats this as fatal rather than silently
    // continuing with a possibly-downgraded principal. Centralizing the log+rethrow
    // here keeps all four call sites (bootstrap main + race winners + ensure-principal)
    // consistent. Uses a plain Error (consistent with this module's existing throws).
    logger.error(
      { err, contactId },
      'repairPrincipalMetadata: failed to repair principal capability metadata (role/system_role/tier/kind) — principal trust gates may not apply until resolved',
    );
    throw err;
  }
}

/**
 * Upsert a KG person node for the CEO and return its id.
 * Uses decay_class='permanent' and confidence=1.0 to match the agent identity pattern —
 * bootstrap nodes are never decayed by the DreamEngine.
 *
 * Adopt-or-mint, the ADR-040 rule applied to the principal. A person node with the same
 * label may already exist — from a concurrent startup, or from email-based contact
 * extraction that ran before bootstrap — and the principal should inherit it rather than
 * start empty beside it.
 *
 * Step 1 promotes an existing *unanchored* node to the principal's identity. It also
 * pins decay_class='permanent' and confidence 1.0: extraction creates person nodes at the
 * default slow_decay, which used to make them eligible for DreamEngine archival once
 * confidence decayed. ADR-040's anchoring now covers that on its own, but the explicit
 * values are kept so the repair still holds for anyone reading decay_class directly.
 * GREATEST ensures we never *demote* a node that already has a higher confidence value.
 * `source` is intentionally not updated: preserving the original creator (e.g.
 * 'extraction') keeps the audit trail honest. (Issue #1004)
 *
 * At most one row can match step 1 — idx_kg_nodes_unique still guarantees one label-tier
 * person node per label — and the identity_source predicate makes it a compare-and-set,
 * so two concurrent boots cannot both adopt.
 *
 * Step 2 mints a fresh anchored node. It needs no ON CONFLICT: anchored nodes are outside
 * idx_kg_nodes_unique, so the INSERT cannot raise 23505 on the label. The cost is that
 * two concurrent boots can each mint one; both call sites resolve that by keeping the
 * node the winning contact actually points at and deleting the unreferenced loser.
 *
 * Returns `created` alongside the id so callers can tell an ADOPTED node — which may
 * already carry facts and edges from extraction — apart from one this call minted. Only
 * the latter is safe to delete on a lost race; deleting the former destroys pre-existing
 * knowledge that was never ours to remove.
 *
 * Exported so ensure-principal.ts can reuse the exact same node-creation semantics
 * for the wizard's no-channel principal-creation path.
 */
export async function insertKgPersonNode(
  displayName: string,
  pool: DbPool,
): Promise<{ id: string; created: boolean }> {
  const adopted = await pool.query<{ id: string }>(
    `UPDATE kg_nodes
        SET identity_source   = 'contact',
            last_confirmed_at = now(),
            decay_class       = 'permanent',
            confidence        = GREATEST(confidence, 1.0)
      WHERE type = 'person'
        AND lower(label) = lower($1)
        AND archived_at IS NULL
        AND identity_source = 'label'
      RETURNING id`,
    [displayName],
  );
  const adoptedId = adopted.rows[0]?.id;
  if (adoptedId) return { id: adoptedId, created: false };

  const created = await pool.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, identity_source)
     VALUES ('person', $1, '{}', 1.0, 'permanent', 'bootstrap', now(), now(), 'contact')
     RETURNING id`,
    [displayName],
  );
  const id = created.rows[0]?.id;
  if (!id) {
    throw new Error('ceo-bootstrap: INSERT INTO kg_nodes returned no rows or no id — check migrations 004, 016 and 085 were applied');
  }
  return { id, created: true };
}

/**
 * Create a KG person node and link it to an existing contact that has kg_node_id = NULL.
 * Returns the actual kg_node_id that ended up on the contact (which may differ from the
 * newly-created node if a concurrent process already set kg_node_id before our UPDATE).
 *
 * Exported so ensure-principal.ts can reuse the same backfill semantics.
 */
export async function createAndLinkKgNode(contactId: string, displayName: string, pool: DbPool): Promise<string> {
  const { id: newKgNodeId, created } = await insertKgPersonNode(displayName, pool);
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
  const linkedKgNodeId = result.rows[0]?.kg_node_id;
  if (!linkedKgNodeId) {
    throw new Error(`ceo-bootstrap: contact ${contactId} still has no kg_node_id after UPDATE — possible concurrent conflict`);
  }
  // Loser-path cleanup: under ADR-040 insertKgPersonNode mints anchored nodes, which no
  // longer collide on the label, so a lost race leaves OUR node unreferenced rather than
  // resolving to the same row. Mirrors ensure-principal.ts — the NOT EXISTS guard keeps
  // the delete safe if a further concurrent writer claimed it in the meantime.
  //
  // Gated on `created`. An ADOPTED node predates this call and may carry extraction facts
  // and edges that would go with it (kg_edges cascades on node delete); losing a link race
  // is no licence to destroy them. Such a node is left anchored but unreferenced — a
  // harmless orphan, and deliberately not reverted to the label tier, since another node
  // may have taken that label in the meantime and the revert would raise 23505 here.
  if (created && linkedKgNodeId !== newKgNodeId) {
    await pool.query(
      `DELETE FROM kg_nodes
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM contacts WHERE kg_node_id = $1)`,
      [newKgNodeId],
    );
  }
  return linkedKgNodeId;
}

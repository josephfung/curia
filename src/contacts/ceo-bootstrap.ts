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
 * Uses ON CONFLICT on the idx_kg_nodes_unique index (migration 016) rather than a blind
 * INSERT, because a person node with the same label may already exist — either from a
 * concurrent startup or from email-based contact extraction that ran before bootstrap.
 * Without this, a blind INSERT would 23505 outside the contact-identity recovery block
 * and propagate as an unhandled error.
 *
 * The DO UPDATE also promotes decay_class to 'permanent' and pins confidence to 1.0
 * on the conflicting row. Email-based extraction creates person nodes with the default
 * slow_decay, which makes them eligible for DreamEngine archival once confidence decays.
 * When that pre-existing node belongs to the principal, bootstrap must repair it — and
 * GREATEST ensures we never *demote* a node that already has a higher confidence value.
 * `source` is intentionally not updated: preserving the original creator (e.g.
 * 'extraction') keeps the audit trail honest; decay protection is controlled
 * exclusively by decay_class, not source.
 * (Issue #1004)
 *
 * Exported so ensure-principal.ts can reuse the exact same node-creation semantics
 * for the wizard's no-channel principal-creation path.
 */
export async function insertKgPersonNode(displayName: string, pool: DbPool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO kg_nodes (type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at)
     VALUES ('person', $1, '{}', 1.0, 'permanent', 'bootstrap', now(), now())
     ON CONFLICT (lower(label), type) WHERE type != 'fact' AND archived_at IS NULL
     DO UPDATE SET last_confirmed_at = now(),
                   decay_class       = 'permanent',
                   confidence        = GREATEST(kg_nodes.confidence, 1.0)
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
 *
 * Exported so ensure-principal.ts can reuse the same backfill semantics.
 */
export async function createAndLinkKgNode(contactId: string, displayName: string, pool: DbPool): Promise<string> {
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

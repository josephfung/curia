-- Up Migration
--
-- Issue #946: Enforce contact/KG boundary.
--
-- Rule: a contacts row exists iff the entity has a channel identity OR an explicit
-- relationship/grant. Pure knowledge (no channel, no relationship) lives in the KG only.
--
-- Part A — Fix held_messages FK, then demote identity-less contacts to KG-only.
--   Contacts with no channel_identities and no system_role are orphaned entries that
--   violate the boundary rule. Without a channel identity the contact row cannot be
--   addressed by any external sender, and any auth overrides on it cannot be honoured
--   (they become an auth trap). KG nodes attached to these contacts are preserved.
--
-- Part B — Backfill kg_node_id for contacts missing it.
--   Step 1: match by display_name against existing KG nodes (case-insensitive).
--   Step 2: for contacts still unmatched, insert new person-typed KG nodes.
--   Step 3: link newly-inserted KG nodes back to the contacts.
--
-- NOTE: after Part A, some of the 19 "missing kg_node_id" contacts may already be
-- gone (they overlap with the identity-less set). Part B only operates on surviving rows.

-- -------------------------------------------------------------------------
-- Part A — Fix held_messages.resolved_contact_id FK before the DELETE
-- -------------------------------------------------------------------------
-- The FK was created without ON DELETE action (migration 007), defaulting to
-- NO ACTION / RESTRICT. If any identity-less contact is referenced as a resolved
-- contact on a held message, the DELETE below would fail with a FK violation.
-- Alter it to SET NULL so the historical reference becomes NULL when the contact
-- row is removed — the held_message record is preserved for audit purposes.

ALTER TABLE held_messages
  DROP CONSTRAINT IF EXISTS held_messages_resolved_contact_id_fkey;
ALTER TABLE held_messages
  ADD CONSTRAINT held_messages_resolved_contact_id_fkey
  FOREIGN KEY (resolved_contact_id)
  REFERENCES contacts(id)
  ON DELETE SET NULL;

-- -------------------------------------------------------------------------
-- Part A — Demote identity-less contacts
-- -------------------------------------------------------------------------

DELETE FROM contacts
WHERE id IN (
  SELECT c.id
  FROM contacts c
  LEFT JOIN contact_channel_identities cci ON cci.contact_id = c.id
  WHERE cci.id IS NULL
    AND c.system_role IS NULL   -- never touch principal / agent rows
);

-- -------------------------------------------------------------------------
-- Part B — Step 1: match surviving contacts to existing KG nodes by label
-- -------------------------------------------------------------------------
-- ROW_NUMBER() ensures we claim at most one contact per KG node
-- (idx_contacts_kg_node_unique is a partial unique index on kg_node_id).

WITH ranked AS (
  SELECT
    c.id         AS contact_id,
    k.id         AS node_id,
    ROW_NUMBER() OVER (
      PARTITION BY k.id
      ORDER BY c.created_at ASC, c.id ASC
    ) AS rn
  FROM contacts c
  JOIN kg_nodes k
    ON  lower(c.display_name) = lower(k.label)
    AND k.type IN ('person', 'organization')
    AND k.archived_at IS NULL
  WHERE c.kg_node_id IS NULL
    AND c.system_role IS NULL
    -- Only claim nodes not already linked to another contact
    AND NOT EXISTS (
      SELECT 1 FROM contacts c2
      WHERE c2.kg_node_id = k.id
    )
)
UPDATE contacts c
SET    kg_node_id = r.node_id
FROM   ranked r
WHERE  c.id = r.contact_id
  AND  r.rn = 1;

-- -------------------------------------------------------------------------
-- Part B — Step 2: insert person KG nodes for still-unmatched contacts
-- -------------------------------------------------------------------------
-- One insertion attempt per distinct display_name; ON CONFLICT handles the
-- (lower(label), type) unique index from migration 016.

INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity)
SELECT
  'person',
  display_name,
  '{}',
  'migration_056',
  0.5,
  'slow_decay',
  'internal'
FROM (
  SELECT DISTINCT ON (lower(display_name))
    display_name
  FROM contacts
  WHERE kg_node_id IS NULL
    AND system_role IS NULL
  ORDER BY lower(display_name), created_at ASC
) unmatched
ON CONFLICT (lower(label), type) WHERE type != 'fact' AND archived_at IS NULL DO NOTHING;

-- -------------------------------------------------------------------------
-- Part B — Step 3: link newly-inserted nodes back to contacts
-- -------------------------------------------------------------------------
-- Same ROW_NUMBER() guard as step 1 in case two contacts share a display_name.

WITH ranked AS (
  SELECT
    c.id         AS contact_id,
    k.id         AS node_id,
    ROW_NUMBER() OVER (
      PARTITION BY k.id
      ORDER BY c.created_at ASC, c.id ASC
    ) AS rn
  FROM contacts c
  JOIN kg_nodes k
    ON  lower(c.display_name) = lower(k.label)
    AND k.type = 'person'
    AND k.source = 'migration_056'
    AND k.archived_at IS NULL
  WHERE c.kg_node_id IS NULL
    AND c.system_role IS NULL
)
UPDATE contacts c
SET    kg_node_id = r.node_id
FROM   ranked r
WHERE  c.id = r.contact_id
  AND  r.rn = 1;

-- Down Migration
--
-- Part A: restore the original FK behaviour (NO ACTION):
--   ALTER TABLE held_messages DROP CONSTRAINT held_messages_resolved_contact_id_fkey;
--   ALTER TABLE held_messages ADD CONSTRAINT held_messages_resolved_contact_id_fkey
--     FOREIGN KEY (resolved_contact_id) REFERENCES contacts(id);
-- The deleted contact rows and their cascading identities / auth overrides cannot
-- be restored from SQL alone. Only run in development.
--
-- Part B: to revert the backfill, NULL out kg_node_id for contacts whose node
-- was created by this migration, then delete those nodes.
--
-- UPDATE contacts SET kg_node_id = NULL
--   WHERE kg_node_id IN (SELECT id FROM kg_nodes WHERE source = 'migration_056');
-- DELETE FROM kg_nodes WHERE source = 'migration_056';

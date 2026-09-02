-- Up Migration
--
-- ADR-040: contact-anchored KG node identity.
--
-- A KG node that backs a contact is identified by that contact; its label is a display
-- attribute carrying no identity. Nodes that back no contact keep (lower(label), type)
-- identity exactly as before. `identity_source` records which tier a node is in so
-- Postgres can enforce the split rather than leaving it to convention.
--
-- Before this migration, two contacts sharing a display name could not both hold a node:
-- the second collided on idx_contacts_kg_node_unique and was stored with kg_node_id = NULL,
-- unable to hold facts, relationships, or entity-context enrichment (#1694, #1623).

-- -------------------------------------------------------------------------
-- Step 1 — the tier column
-- -------------------------------------------------------------------------

ALTER TABLE kg_nodes
  ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'label'
  CHECK (identity_source IN ('label', 'contact'));

COMMENT ON COLUMN kg_nodes.identity_source IS 'ADR-040 identity tier. label = identified by (lower(label), type) and deduplicated by idx_kg_nodes_unique; the default for every node not backing a contact. contact = identified by the contact pointing at it via contacts.kg_node_id; its label is free to collide and DreamEngine never decays or archives it.';

-- -------------------------------------------------------------------------
-- Step 2 — promote existing contact-linked nodes to the anchored tier
-- -------------------------------------------------------------------------
-- Organization nodes are deliberately excluded: they are legitimately shared by several
-- role-address contacts at one domain, so they stay label-keyed and unanchored. Every
-- other linked node becomes the durable identity of the contact pointing at it.

UPDATE kg_nodes n
   SET identity_source = 'contact'
  FROM contacts c
 WHERE c.kg_node_id = n.id
   AND n.type <> 'organization'
   AND n.archived_at IS NULL;

-- Clear decay warnings on the nodes just anchored. DreamEngine's Pass 2a archives any
-- node whose warning outlives warnHoldBackDays, and it is deliberately left without an
-- identity_source predicate: a node can only be warned once its confidence falls to the
-- archive threshold, which an anchored node no longer decays towards. That reasoning
-- only holds for warnings raised from here on, so retire the ones already in flight —
-- a pending "confirm or lose this" prompt is void for a node we now guarantee to keep.

UPDATE kg_nodes
   SET warned_at = NULL,
       warn_reason = NULL
 WHERE identity_source = 'contact'
   AND warned_at IS NOT NULL;

-- -------------------------------------------------------------------------
-- Step 3 — narrow label uniqueness to the label tier
-- -------------------------------------------------------------------------
-- The new predicate is a strict subset of the old one (same columns, one extra AND), so
-- the index cannot fail to build on rows the previous index already accepted.

DROP INDEX idx_kg_nodes_unique;
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL AND identity_source = 'label';

-- -------------------------------------------------------------------------
-- Step 4 — let organization contacts share their organization's node
-- -------------------------------------------------------------------------
-- resolveOrCreateOrgNode() returns the SAME org node for every role address at a domain
-- (info@acme.com mints it, support@acme.com resolves to it). The 1:1 invariant is simply
-- wrong for that shape. Also a strict subset of the old predicate, so it cannot fail.

DROP INDEX idx_contacts_kg_node_unique;
CREATE UNIQUE INDEX idx_contacts_kg_node_unique
  ON contacts (kg_node_id)
  WHERE kg_node_id IS NOT NULL AND kind <> 'organization';

-- -------------------------------------------------------------------------
-- Step 5 — backfill arm A: re-link nodeless organization contacts
-- -------------------------------------------------------------------------
-- A nodeless organization contact whose email domain matches an existing org node's
-- properties->>'domain' is linked to that node — reconstructing exactly the link the
-- original collision denied. Legal only now that step 4 has relaxed the contacts index.
--
-- DISTINCT ON picks one node deterministically if several org nodes claim the domain
-- (highest confidence, then oldest, then id) rather than failing the migration.
--
-- Measured at 0 rows in production on 2026-09-02 (scripts/kg-node-linkage-report.ts):
-- this arm is prevention for other deployments, not repair of a known backlog.

WITH candidates AS (
  SELECT DISTINCT ON (c.id)
         c.id AS contact_id,
         n.id AS node_id
    FROM contacts c
    JOIN kg_nodes n
      ON  n.type = 'organization'
      AND n.archived_at IS NULL
      AND lower(n.properties->>'domain') = lower(split_part(c.primary_email, '@', 2))
   WHERE c.kg_node_id IS NULL
     AND c.kind = 'organization'
     AND c.primary_email IS NOT NULL
     AND position('@' in c.primary_email) > 0
   ORDER BY c.id, n.confidence DESC, n.created_at ASC, n.id ASC
)
UPDATE contacts c
   SET kg_node_id = candidates.node_id,
       updated_at = now()
  FROM candidates
 WHERE c.id = candidates.contact_id;

-- -------------------------------------------------------------------------
-- Step 6 — backfill arm B: mint an anchored node per remaining nodeless contact
-- -------------------------------------------------------------------------
-- One node per CONTACT, not one per distinct display_name. Migration 056 minted per
-- display_name, which is precisely why 12 same-name contacts were left nodeless.
--
-- Anchored nodes are outside idx_kg_nodes_unique, so this INSERT cannot raise a unique
-- violation however many contacts share a name — the property that keeps this migration
-- safe to run against an unknown deployment.
--
-- Deliberately makes no attempt to detect that two nodeless "Seth Berman" contacts might
-- be one person. That is the dedup sweep's ruling to make, and it now works better:
-- mergeContacts only carries KG memory when both sides have a node.
--
-- Convention (confidence 0.5, slow_decay, internal, no embedding) mirrors migration 056.
-- The contact id is recorded in properties so the nodes can be mapped back below and so
-- the provenance survives in the row itself.

WITH minted AS (
  INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity, identity_source)
  SELECT
    CASE WHEN c.kind = 'organization' THEN 'organization' ELSE 'person' END,
    c.display_name,
    jsonb_build_object('backfilled_for_contact', c.id),
    'migration_085',
    0.5,
    'slow_decay',
    'internal',
    'contact'
  FROM contacts c
  WHERE c.kg_node_id IS NULL
  RETURNING id, (properties->>'backfilled_for_contact')::uuid AS contact_id
)
UPDATE contacts c
   SET kg_node_id = minted.id,
       updated_at = now()
  FROM minted
 WHERE c.id = minted.contact_id;

-- Down Migration

-- Restore the pre-ADR-040 index predicates, then drop the column.
--
-- NOT reliably reversible: once two contacts hold same-label anchored nodes, recreating
-- the un-narrowed idx_kg_nodes_unique raises a unique violation and this down migration
-- fails. That is correct — silently deleting one of two real people's nodes to satisfy an
-- index would be worse. Resolve the duplicates by hand (merge or archive) and re-run.
--
-- The backfilled rows themselves are left in place; to remove them:
--   UPDATE contacts SET kg_node_id = NULL
--     WHERE kg_node_id IN (SELECT id FROM kg_nodes WHERE source = 'migration_085');
--   DELETE FROM kg_nodes WHERE source = 'migration_085';

DROP INDEX IF EXISTS idx_contacts_kg_node_unique;
CREATE UNIQUE INDEX idx_contacts_kg_node_unique
  ON contacts (kg_node_id)
  WHERE kg_node_id IS NOT NULL;

DROP INDEX IF EXISTS idx_kg_nodes_unique;
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL;

ALTER TABLE kg_nodes DROP COLUMN IF EXISTS identity_source;

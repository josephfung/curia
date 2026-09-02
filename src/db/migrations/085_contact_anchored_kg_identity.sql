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

-- Step 2a — un-archive the nodes of contacts that are still live.
--
-- A contact can point at an ARCHIVED node: pre-085 DreamEngine Pass 2b archived any node
-- at or below archiveThreshold with no contact exclusion, and dismissDecayWarning archives
-- on demand. Such a contact is already broken in exactly the way #1694 is about — getNode()
-- filters archived_at, so it resolves to nothing and the contact holds no facts, no
-- relationships and no enrichment, while its kg_node_id looks perfectly healthy.
--
-- Without this step it would stay broken and be invisible to both arms: step 2 skips it
-- (archived), and arm B skips it (kg_node_id IS NOT NULL). It would fall through the
-- migration entirely.
--
-- Restoring is the ADR-040 position rather than a judgement call: a live contact's anchor
-- should never have decayed away, and any dismissal predates the existence of the anchored
-- tier. The facts underneath stay exactly as they are; only the container comes back.
-- Confidence is lifted clear of the archive threshold so the node is not re-archived on the
-- next pass by some path this migration has not anticipated.

UPDATE kg_nodes n
   SET archived_at = NULL,
       identity_source = 'contact',
       confidence = GREATEST(n.confidence, 0.5),
       warned_at = NULL,
       warn_reason = NULL
  FROM contacts c
 WHERE c.kg_node_id = n.id
   AND n.type <> 'organization'
   AND n.archived_at IS NOT NULL;

-- Clear decay warnings on the nodes just anchored. DreamEngine now excludes anchored rows
-- from its warn pass and from both archival passes, so no NEW warning can be raised for
-- one. This retires the warnings already in flight: a pending "confirm this or lose it"
-- prompt is void for a node we have just guaranteed to keep, and Pass 2a would otherwise
-- leave it warned forever.

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
-- Step 6 — backfill arm B: give every remaining nodeless contact a node
-- -------------------------------------------------------------------------
-- Split by kind, because the two tiers need different collision strategies.
--
-- Both halves skip system_role IS NOT NULL rows, exactly as migration 056 did. A nodeless
-- principal or agent contact is backfilled at startup by ensurePrincipalContact() /
-- bootstrapAgentIdentity(), which resolve their nodes through their own singleton indexes.
-- Minting a plain person node for one here would leave bootstrap's ON CONFLICT unable to
-- match it, and it would insert a second agent contact and trip
-- idx_contacts_system_role_agent on every startup.

-- Step 6a — non-organization contacts: one ANCHORED node per CONTACT.
--
-- Per contact, not per distinct display_name. Migration 056 minted per display_name, which
-- is precisely why 12 same-name contacts were left nodeless.
--
-- Anchored nodes are outside idx_kg_nodes_unique, so this INSERT cannot raise a unique
-- violation however many contacts share a name — the property that keeps this migration
-- safe to run against an unknown deployment.
--
-- Deliberately makes no attempt to detect that two nodeless "Seth Berman" contacts might
-- be one person. That is the dedup sweep's ruling to make. (Note the sweep does NOT yet
-- carry KG memory across a merge, because mergeEntities trips the contacts FK: see #1711.)
--
-- Convention (confidence 0.5, slow_decay, internal, no embedding) mirrors migration 056.
-- The contact id is recorded in properties so the nodes can be mapped back below and so
-- the provenance survives in the row itself.

WITH minted AS (
  INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity, identity_source)
  SELECT
    'person',
    c.display_name,
    jsonb_build_object('backfilled_for_contact', c.id),
    'migration_085',
    0.5,
    'slow_decay',
    'internal',
    'contact'
  FROM contacts c
  WHERE c.kg_node_id IS NULL
    AND c.kind <> 'organization'
    AND c.system_role IS NULL
  RETURNING id, (properties->>'backfilled_for_contact')::uuid AS contact_id
)
UPDATE contacts c
   SET kg_node_id = minted.id,
       updated_at = now()
  FROM minted
 WHERE c.id = minted.contact_id;

-- Step 6b — organization contacts: a LABEL-TIER node, shared by display name.
--
-- Organization nodes stay unanchored, matching step 2 and ADR-040: they are legitimately
-- shared by several role addresses and outlive any one contact. Anchoring them would take
-- them out of idx_kg_nodes_unique, so resolveOrCreateOrgNode could mint a second node for
-- the same organization, and contact deletion could archive a node its siblings still use.
--
-- Being label-tier means these CAN collide, so unlike 6a this is one node per distinct
-- display_name with ON CONFLICT DO NOTHING, then a separate link step — the same two-step
-- shape migration 056 used for the same reason. DO NOTHING also covers the case where a
-- label-tier org node with that label already exists; step 6c then links to it.

-- The domain is carried into properties so resolveOrCreateOrgNode()'s FIRST lookup
-- (properties->>'domain') can find this node later. Without it, the next role address at
-- the same domain resolves nothing and mints a second org node for one organization.
INSERT INTO kg_nodes (type, label, properties, source, confidence, decay_class, sensitivity, identity_source)
SELECT
  'organization',
  display_name,
  CASE
    WHEN domain <> '' THEN jsonb_build_object('domain', domain)
    ELSE '{}'::jsonb
  END,
  'migration_085',
  0.5,
  'slow_decay',
  'internal',
  'label'
FROM (
  SELECT DISTINCT ON (lower(display_name))
         display_name,
         lower(split_part(COALESCE(primary_email, ''), '@', 2)) AS domain
    FROM contacts
   WHERE kg_node_id IS NULL
     AND kind = 'organization'
     AND system_role IS NULL
   ORDER BY lower(display_name), created_at ASC
) unmatched
ON CONFLICT (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL AND identity_source = 'label'
  DO NOTHING;

-- Step 6c — link organization contacts to their label-tier node.
-- No ROW_NUMBER guard is needed on the contacts side: step 4 exempted kind='organization'
-- from idx_contacts_kg_node_unique precisely so several may share one node.

UPDATE contacts c
   SET kg_node_id = n.id,
       updated_at = now()
  FROM kg_nodes n
 WHERE c.kg_node_id IS NULL
   AND c.kind = 'organization'
   AND c.system_role IS NULL
   AND n.type = 'organization'
   AND n.archived_at IS NULL
   AND n.identity_source = 'label'
   AND lower(n.label) = lower(c.display_name);

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

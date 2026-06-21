-- Migration 062: Promote the principal's KG person node to permanent decay class.
--
-- Root cause (issue #1004): insertKgPersonNode uses ON CONFLICT DO UPDATE to handle
-- pre-existing person nodes (e.g. created by email-based extraction with the default
-- slow_decay). Before this migration's companion forward fix, the DO UPDATE only
-- refreshed last_confirmed_at, leaving decay_class and confidence unchanged. A
-- slow_decay principal node is eligible for DreamEngine archival once confidence
-- decays — the most critical entity in the graph should never be in that state.
--
-- This migration is the one-time backfill for already-affected instances.
-- The forward fix (also in issue #1004) ensures new bootstrap runs always promote.
--
-- Scope: only the node linked from the principal contact (system_role='principal').
-- Promotion never demotes: GREATEST preserves any confidence already above 1.0.
--
-- Edge case: if contacts.kg_node_id IS NULL for the principal (e.g. an instance
-- that never ran the #380 fix), this migration updates 0 rows — that is correct.
-- The forward fix in insertKgPersonNode handles that case at the next bootstrap run.

UPDATE kg_nodes
   SET decay_class       = 'permanent',
       confidence        = GREATEST(confidence, 1.0),
       last_confirmed_at = now()
 WHERE id IN (
       SELECT kg_node_id
         FROM contacts
        WHERE system_role = 'principal'
          AND kg_node_id IS NOT NULL
       )
   AND archived_at IS NULL
   AND decay_class != 'permanent';

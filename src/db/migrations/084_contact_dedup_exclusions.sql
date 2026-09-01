-- Up Migration: first-class contact dedup exclusions table (#1625)
--
-- Dedup exclusions ("the CEO ruled these two contacts are NOT the same person")
-- used to live as KG fact nodes on each contact's entity node. That was the wrong
-- store: an exclusion is pair-relational operational state, not learned knowledge
-- about one entity. Consequences we are fixing here (see ADR-039):
--   - It required a KG node on at least one side. Contacts that share a display
--     name deliberately carry kg_node_id = NULL (createContact drops the link on
--     idx_contacts_kg_node_unique collisions), so the population that most needs
--     an exclusion could not hold one at all (#1623).
--   - "dedup_exclusion: <uuid>" labels are ~0.99 cosine neighbours of each other,
--     so every additional exclusion looked like a duplicate fact or a contradiction.
--   - Cost: 2 nodes + 2 edges per pair, and every later fact write on those
--     entities walked each edge for cosine dedup.

CREATE TABLE contact_dedup_exclusions (
  contact_a_id UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_b_id UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Provenance only (agent memory-write source key, or 'ceo'). Deliberately not a
  -- decision enum: this table records exclusions, never merge outcomes (#1625).
  -- Non-empty: NOT NULL alone would let a blank source through, and provenance is the
  -- only audit trail a row carries.
  decided_by   TEXT        NOT NULL CHECK (decided_by <> ''),
  PRIMARY KEY (contact_a_id, contact_b_id),
  -- Normalized ordered pair: exactly one row can exist per unordered pair, so
  -- "is this pair excluded?" is a single indexed lookup with no OR-of-two-orders.
  CONSTRAINT contact_dedup_exclusions_ordered_pair CHECK (contact_a_id < contact_b_id)
);

-- The primary key covers lookups anchored on contact_a_id. Exclusions are also
-- scanned from the B side (contact delete cascade, merge re-pointing), which
-- would otherwise be a sequential scan.
CREATE INDEX idx_contact_dedup_exclusions_b
  ON contact_dedup_exclusions (contact_b_id);

-- >>> BEGIN BACKFILL (integration test re-runs this section standalone; keep the sentinel)
-- Backfill from existing KG dedup_exclusion facts.
--
-- Shape of the legacy data: a 'fact' node with properties.attribute =
-- 'dedup_exclusion' and properties.value = the OTHER contact's id, linked by a
-- 'relates_to' kg_edge to the entity node of the contact holding the exclusion.
-- storeFact always writes the edge entity -> fact, but getFacts() reads edges in
-- both directions, so the join below accepts either orientation for safety.
--
-- Both sides must still resolve to live contacts; anything dangling (deleted
-- contact, unparseable value) is dropped rather than backfilled. Old fact nodes
-- are intentionally left in place — this is a single cutover, not a dual write,
-- and keeping them preserves an audit trail of the pre-migration decisions.
WITH exclusion_facts AS MATERIALIZED (
  -- Resolve properties.value to a uuid ONLY for rows that pass the regex guard.
  -- This must be its own MATERIALIZED CTE: in a single flat query the planner is
  -- free to evaluate a cast in a join condition before the WHERE filter that guards
  -- it, so one malformed legacy value would abort the migration — and migrations run
  -- at process boot, so that takes the whole service down (cf. migration 070).
  -- Within a single scan, quals are applied before the target list, and MATERIALIZED
  -- stops the CTE being inlined back into the outer joins.
  SELECT
    fact.id                             AS fact_id,
    fact.created_at                     AS created_at,
    (fact.properties ->> 'value')::uuid AS other_contact_id
  FROM kg_nodes AS fact
  WHERE fact.type = 'fact'
    AND fact.properties ->> 'attribute' = 'dedup_exclusion'
    AND fact.properties ->> 'value' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
INSERT INTO contact_dedup_exclusions (contact_a_id, contact_b_id, decided_at, decided_by)
SELECT
  LEAST(holder.id, other.id)    AS contact_a_id,
  GREATEST(holder.id, other.id) AS contact_b_id,
  MIN(ef.created_at)            AS decided_at,
  'migration-084-backfill'      AS decided_by
FROM exclusion_facts AS ef
JOIN kg_edges AS edge
  ON edge.source_node_id = ef.fact_id OR edge.target_node_id = ef.fact_id
JOIN kg_nodes AS entity
  ON entity.id = CASE WHEN edge.source_node_id = ef.fact_id
                      THEN edge.target_node_id
                      ELSE edge.source_node_id END
  -- The node on the other end of the edge must be the entity, not another fact.
  AND entity.type <> 'fact'
JOIN contacts AS holder
  ON holder.kg_node_id = entity.id
JOIN contacts AS other
  ON other.id = ef.other_contact_id
-- A self-referential exclusion (contact excluded against itself) is corrupt data
-- and would violate the ordered-pair CHECK.
WHERE holder.id <> other.id
-- Both mirrored facts of one pair (the old writeExclusion wrote one per side)
-- collapse into a single row; the earliest fact dates the decision.
GROUP BY LEAST(holder.id, other.id), GREATEST(holder.id, other.id)
ON CONFLICT (contact_a_id, contact_b_id) DO NOTHING;

-- Report legacy facts the backfill could NOT carry over. Without this the migration is
-- green whether it recovered 40 of 40 rulings or 12 of 40, and the first symptom of a
-- partial recovery is a dedup review task for a pair the CEO settled months ago.
--
-- The likeliest cause is the one this whole change is about: a holder contact whose
-- kg_node_id was NULLed by an idx_contacts_kg_node_unique collision after its exclusion
-- fact was written no longer joins to its own fact, so the same-display-name population
-- is also the population most likely to lose history here. The fact nodes are left in
-- place, so anything reported below can still be recovered by hand.
--
-- The resolution join is deliberately repeated rather than approximated by "does any
-- exclusion row mention this contact" — that shortcut counts a fact as recovered when
-- an unrelated pair involving the same contact made it across, which under-reports
-- exactly the loss this warning exists to surface. Both mirrored facts of one pair
-- resolve, so a fully-recovered dataset has total = resolved.
DO $$
DECLARE
  total_facts    INT;
  resolved_facts INT;
BEGIN
  SELECT count(*) INTO total_facts
  FROM kg_nodes AS fact
  WHERE fact.type = 'fact'
    AND fact.properties ->> 'attribute' = 'dedup_exclusion';

  SELECT count(DISTINCT ef.fact_id) INTO resolved_facts
  FROM (
    SELECT
      fact.id                             AS fact_id,
      (fact.properties ->> 'value')::uuid AS other_contact_id
    FROM kg_nodes AS fact
    WHERE fact.type = 'fact'
      AND fact.properties ->> 'attribute' = 'dedup_exclusion'
      AND fact.properties ->> 'value' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- OFFSET 0 is an optimization fence: it stops the subquery being pulled up into the
    -- joins below, which would let the planner reach the ::uuid cast before the regex.
    OFFSET 0
  ) AS ef
  JOIN kg_edges AS edge
    ON edge.source_node_id = ef.fact_id OR edge.target_node_id = ef.fact_id
  JOIN kg_nodes AS entity
    ON entity.id = CASE WHEN edge.source_node_id = ef.fact_id
                        THEN edge.target_node_id
                        ELSE edge.source_node_id END
    AND entity.type <> 'fact'
  JOIN contacts AS holder
    ON holder.kg_node_id = entity.id
  JOIN contacts AS other
    ON other.id = ef.other_contact_id
  WHERE holder.id <> other.id;

  IF total_facts > resolved_facts THEN
    RAISE WARNING 'migration 084: % of % legacy dedup_exclusion fact(s) could NOT be backfilled (holder contact has no kg_node_id link, counterparty deleted, or malformed value). Those CEO rulings are absent from contact_dedup_exclusions; the fact nodes are preserved for manual recovery.',
      total_facts - resolved_facts, total_facts;
  ELSE
    RAISE NOTICE 'migration 084: all % legacy dedup_exclusion fact(s) backfilled.', total_facts;
  END IF;
END $$;
-- <<< END BACKFILL

-- Rollback:
--   DROP TABLE contact_dedup_exclusions;
-- The legacy KG dedup_exclusion fact nodes are untouched by this migration, so a
-- rollback restores the previous behaviour for every pair that had one. Pairs
-- excluded after this migration ships exist only in the table and would be lost.

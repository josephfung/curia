-- Up Migration
-- Phase 1 tools/skills vocabulary (#1485 / ADR-031): rename the atom lifecycle
-- table skill_registry → tool_registry. Row data is preserved via RENAME.
-- Trigger + function names follow for clarity; behavior is unchanged.
--
-- Also renames the discovery-atom registry row skill-registry → tool-registry
-- so enable/disable intent survives the atom rename (avoids a ghost row + a
-- fresh default-enabled re-enrollment that would ignore a prior disable).
--
-- Idempotent: a DB that somehow already has tool_registry (and no skill_registry)
-- is a no-op for the table rename; the atom-row UPDATE is also guarded.

DO $$
BEGIN
  IF to_regclass('public.skill_registry') IS NOT NULL
     AND to_regclass('public.tool_registry') IS NULL THEN
    ALTER TABLE skill_registry RENAME TO tool_registry;
    ALTER TRIGGER skill_registry_updated_at ON tool_registry
      RENAME TO tool_registry_updated_at;
    ALTER FUNCTION skill_registry_set_updated_at()
      RENAME TO tool_registry_set_updated_at;
  ELSIF to_regclass('public.tool_registry') IS NOT NULL THEN
    RAISE NOTICE 'tool_registry already present — skip table rename';
  ELSE
    RAISE EXCEPTION 'neither skill_registry nor tool_registry exists';
  END IF;

  -- Carry the discovery atom's registry row across the rename (PK is `name`).
  -- Runs whether we just renamed the table or it already existed (e.g. a
  -- previous 075 without this UPDATE, or a re-run after a partial apply).
  IF to_regclass('public.tool_registry') IS NOT NULL THEN
    UPDATE tool_registry
       SET name = 'tool-registry'
     WHERE name = 'skill-registry'
       AND NOT EXISTS (
         SELECT 1 FROM tool_registry WHERE name = 'tool-registry'
       );
    -- If reconciliation already enrolled tool-registry beside a leftover
    -- skill-registry row, drop the ghost so the Tools console stays clean.
    DELETE FROM tool_registry WHERE name = 'skill-registry';
  END IF;
END $$;

-- Down Migration
DO $$
BEGIN
  IF to_regclass('public.tool_registry') IS NOT NULL THEN
    UPDATE tool_registry
       SET name = 'skill-registry'
     WHERE name = 'tool-registry'
       AND NOT EXISTS (
         SELECT 1 FROM tool_registry WHERE name = 'skill-registry'
       );
  END IF;

  IF to_regclass('public.tool_registry') IS NOT NULL
     AND to_regclass('public.skill_registry') IS NULL THEN
    ALTER FUNCTION tool_registry_set_updated_at()
      RENAME TO skill_registry_set_updated_at;
    ALTER TRIGGER tool_registry_updated_at ON tool_registry
      RENAME TO skill_registry_updated_at;
    ALTER TABLE tool_registry RENAME TO skill_registry;
  END IF;
END $$;

-- Up Migration
-- Phase 1 tools/skills vocabulary (#1485 / ADR-031): rename the atom lifecycle
-- table skill_registry → tool_registry. Row data is preserved via RENAME.
-- Trigger + function names follow for clarity; behavior is unchanged.
--
-- Idempotent: a DB that somehow already has tool_registry (and no skill_registry)
-- is a no-op so re-runs / unusual restore paths do not fail closed.

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
    RAISE NOTICE 'tool_registry already present — skip rename';
  ELSE
    RAISE EXCEPTION 'neither skill_registry nor tool_registry exists';
  END IF;
END $$;

-- Down Migration
DO $$
BEGIN
  IF to_regclass('public.tool_registry') IS NOT NULL
     AND to_regclass('public.skill_registry') IS NULL THEN
    ALTER FUNCTION tool_registry_set_updated_at()
      RENAME TO skill_registry_set_updated_at;
    ALTER TRIGGER tool_registry_updated_at ON tool_registry
      RENAME TO skill_registry_updated_at;
    ALTER TABLE tool_registry RENAME TO skill_registry;
  END IF;
END $$;

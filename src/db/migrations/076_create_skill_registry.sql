-- Up Migration
-- Phase 2 tools/skills architecture (#1489): skill (bundle) lifecycle table.
-- Parallel to tool_registry (atoms) and agent_registry. State is derived in app
-- code by cross-referencing rows against on-disk SKILL.md discovery.
--
-- Fresh installs get an empty table; reconcile enrolls defaults from
-- config/registry-defaults.yaml (skills:). Existing DBs that already ran
-- Phase 1 (075 → tool_registry) apply this as an additive migration.

CREATE TABLE IF NOT EXISTS skill_registry (
  name         TEXT PRIMARY KEY,                 -- matches SKILL.md frontmatter name
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION skill_registry_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

DROP TRIGGER IF EXISTS skill_registry_updated_at ON skill_registry;
CREATE TRIGGER skill_registry_updated_at
  BEFORE UPDATE ON skill_registry
  FOR EACH ROW EXECUTE FUNCTION skill_registry_set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS skill_registry_updated_at ON skill_registry;
DROP FUNCTION IF EXISTS skill_registry_set_updated_at();
DROP TABLE IF EXISTS skill_registry;

-- Up Migration
-- Phase 1 tools/skills vocabulary (#1485 / ADR-031): rename the atom lifecycle
-- table skill_registry → tool_registry. Row data is preserved via RENAME.
-- Trigger + function names follow for clarity; behavior is unchanged.

ALTER TABLE skill_registry RENAME TO tool_registry;

ALTER TRIGGER skill_registry_updated_at ON tool_registry
  RENAME TO tool_registry_updated_at;

ALTER FUNCTION skill_registry_set_updated_at()
  RENAME TO tool_registry_set_updated_at;

-- Down Migration
ALTER FUNCTION tool_registry_set_updated_at()
  RENAME TO skill_registry_set_updated_at;

ALTER TRIGGER tool_registry_updated_at ON tool_registry
  RENAME TO skill_registry_updated_at;

ALTER TABLE tool_registry RENAME TO skill_registry;

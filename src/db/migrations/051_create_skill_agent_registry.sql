-- Up Migration
-- Database-backed registry that gates skill/agent loading on an install/enable
-- lifecycle (spec: docs/wip/2026-06-09-skill-agent-registry-design.md, #541).
-- Stores only enabled + timestamps; the uninstalled/installed/enabled/ghost states
-- are derived in app code by cross-referencing these rows against on-disk manifests.

CREATE TABLE skill_registry (
  name         TEXT PRIMARY KEY,                 -- matches skill.json "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,                      -- set when enabled flips true, cleared on disable
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_registry (
  name         TEXT PRIMARY KEY,                 -- matches agents/<name>.yaml "name"
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by TEXT        NOT NULL DEFAULT 'system',
  enabled_at   TIMESTAMPTZ,
  enabled_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No secondary indexes: both tables hold dozens of rows at most and the only hot
-- query is a full "list all rows" at startup. The PRIMARY KEY on name suffices.

-- Trigger to auto-maintain updated_at on any UPDATE, regardless of whether the
-- caller explicitly sets it (e.g. admin queries, bulk enables).
CREATE OR REPLACE FUNCTION skill_registry_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

CREATE TRIGGER skill_registry_updated_at
  BEFORE UPDATE ON skill_registry
  FOR EACH ROW EXECUTE FUNCTION skill_registry_set_updated_at();

CREATE OR REPLACE FUNCTION agent_registry_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

CREATE TRIGGER agent_registry_updated_at
  BEFORE UPDATE ON agent_registry
  FOR EACH ROW EXECUTE FUNCTION agent_registry_set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS skill_registry_updated_at ON skill_registry;
DROP FUNCTION IF EXISTS skill_registry_set_updated_at();
DROP TRIGGER IF EXISTS agent_registry_updated_at ON agent_registry;
DROP FUNCTION IF EXISTS agent_registry_set_updated_at();
DROP TABLE IF EXISTS skill_registry;
DROP TABLE IF EXISTS agent_registry;

-- src/db/migrations/052_create_channel_registry.sql
-- Up Migration
-- Database-backed registry that gates channel adapter startup on an install/enable
-- lifecycle (spec: docs/wip/2026-06-12-channel-registry-design.md, #543). Mirrors
-- skill_registry/agent_registry, plus is_toggleable: false for http/cli, which always
-- start and cannot be disabled (operator-lockout safeguard). Credentials live in the
-- secrets vault (channel.<name>.<field>); this table stores only lifecycle state.

CREATE TABLE channel_registry (
  name          TEXT PRIMARY KEY,                 -- matches a CHANNEL_CATALOG descriptor name
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  is_toggleable BOOLEAN     NOT NULL DEFAULT true, -- false for http, cli
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT        NOT NULL DEFAULT 'system',
  enabled_at    TIMESTAMPTZ,                       -- set when enabled flips true, cleared on disable
  enabled_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION channel_registry_set_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
$$;

CREATE TRIGGER channel_registry_updated_at
  BEFORE UPDATE ON channel_registry
  FOR EACH ROW EXECUTE FUNCTION channel_registry_set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS channel_registry_updated_at ON channel_registry;
DROP FUNCTION IF EXISTS channel_registry_set_updated_at();
DROP TABLE IF EXISTS channel_registry;

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

-- Down Migration
DROP TABLE skill_registry;
DROP TABLE agent_registry;

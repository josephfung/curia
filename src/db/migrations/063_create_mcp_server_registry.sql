-- src/db/migrations/063_create_mcp_server_registry.sql
-- Tracks the install/enable lifecycle for MCP servers declared in skills.yaml.
-- Mirrors channel_registry; no is_toggleable column (all MCP servers are toggleable).

CREATE TABLE mcp_server_registry (
  name          TEXT        NOT NULL PRIMARY KEY,
  enabled       BOOLEAN     NOT NULL DEFAULT false,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by  TEXT        NOT NULL,
  enabled_at    TIMESTAMPTZ,
  enabled_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

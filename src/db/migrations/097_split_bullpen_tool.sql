-- 097_split_bullpen_tool.sql
--
-- The polymorphic `bullpen` tool is now the `bullpen` skill bundle with four tools:
-- bullpen-post, bullpen-reply, bullpen-read and bullpen-close (#2126). Carry the old
-- tool row's state, including an admin's disable, to the bundle and each new tool,
-- then drop the old row so it does not linger as a ghost. A fresh install has no
-- `bullpen` tool row, and reconciliation enrolls the bundle from registry-defaults.yaml.
-- An existing row for a new name is left alone.
--
-- Rows this migration creates are installed_by 'migration:097', so the downgrade
-- removes only those and leaves any row it did not create.

-- Up Migration

INSERT INTO tool_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT t.name, old.enabled, old.installed_at, 'migration:097', old.enabled_at, old.enabled_by
  FROM tool_registry old
 CROSS JOIN (VALUES ('bullpen-post'), ('bullpen-reply'), ('bullpen-read'), ('bullpen-close')) AS t(name)
 WHERE old.name = 'bullpen'
ON CONFLICT (name) DO NOTHING;

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'bullpen', enabled, installed_at, 'migration:097', enabled_at, enabled_by
  FROM tool_registry
 WHERE name = 'bullpen'
ON CONFLICT (name) DO NOTHING;

DELETE FROM tool_registry WHERE name = 'bullpen';

-- Down Migration

INSERT INTO tool_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'bullpen', enabled, installed_at, 'migration:097', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'bullpen'
ON CONFLICT (name) DO NOTHING;

DELETE FROM tool_registry
 WHERE name IN ('bullpen-post', 'bullpen-reply', 'bullpen-read', 'bullpen-close')
   AND installed_by = 'migration:097';
DELETE FROM skill_registry WHERE name = 'bullpen' AND installed_by = 'migration:097';

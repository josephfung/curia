-- 134_split_learning_and_reports_skills.sql
--
-- #2764 PR 3a2 splits the `learning` skill into `learning-jobs` (producers on
-- ceo-inbox) and `learning-digest` (list/resolve on the coordinator), and the
-- `reports` skill into `digest` (list/ack/spot-check) with `report-to-principal`
-- remaining a standalone tool pin. Carry each old skill row's enabled state to
-- the new names so a prod install that had `learning` / `reports` enabled keeps
-- the review tools after deploy, then drop the old rows so they do not linger as
-- ghosts. A fresh install has no old rows; reconciliation enrolls the new skills
-- from registry-defaults / onboarding REQUIRED_ENTRIES.
--
-- Rows this migration creates are installed_by 'migration:134', so the downgrade
-- removes only those and leaves any row it did not create.

-- Up Migration

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'learning-jobs', enabled, installed_at, 'migration:134', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'learning'
ON CONFLICT (name) DO NOTHING;

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'learning-digest', enabled, installed_at, 'migration:134', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'learning'
ON CONFLICT (name) DO NOTHING;

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'digest', enabled, installed_at, 'migration:134', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'reports'
ON CONFLICT (name) DO NOTHING;

DELETE FROM skill_registry WHERE name IN ('learning', 'reports');

-- Down Migration

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'learning', enabled, installed_at, 'migration:134', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'learning-jobs'
ON CONFLICT (name) DO NOTHING;

INSERT INTO skill_registry (name, enabled, installed_at, installed_by, enabled_at, enabled_by)
SELECT 'reports', enabled, installed_at, 'migration:134', enabled_at, enabled_by
  FROM skill_registry
 WHERE name = 'digest'
ON CONFLICT (name) DO NOTHING;

DELETE FROM skill_registry
 WHERE name IN ('learning-jobs', 'learning-digest', 'digest')
   AND installed_by = 'migration:134';

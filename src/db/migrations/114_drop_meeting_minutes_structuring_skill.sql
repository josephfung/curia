-- 114_drop_meeting_minutes_structuring_skill.sql
--
-- The `meeting-minutes-structuring` playbook moved into the `meetings` bundle (#2400),
-- and its SKILL.md is gone. Drop its registry row so it does not linger as a ghost
-- that warns on every boot. A fresh install never enrolls it: registry-defaults.yaml
-- no longer lists it.
--
-- The downgrade restores an enabled row marked installed_by 'migration:114'. The old
-- code it would run against expects the skill to be enrolled.

-- Up Migration

DELETE FROM skill_registry WHERE name = 'meeting-minutes-structuring';

-- Down Migration

INSERT INTO skill_registry (name, enabled, installed_by, enabled_at, enabled_by)
VALUES ('meeting-minutes-structuring', true, 'migration:114', now(), 'migration:114')
ON CONFLICT (name) DO NOTHING;

-- Up Migration

ALTER TABLE bullpen_threads ADD COLUMN originator JSONB;

-- Rollback: ALTER TABLE bullpen_threads DROP COLUMN originator;

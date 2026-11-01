-- 110_web_thread.sql
--
-- The principal's single web conversation (#2341, ADR-055). One row. On first
-- use the application copies the most recently active web conversation out of
-- working_memory; other per-browser threads are left to age out.

-- Up Migration

CREATE TABLE web_thread (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  conversation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS web_thread;

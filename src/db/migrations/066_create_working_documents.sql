-- Up Migration
-- Agent document workspace foundation (#1208): OKF-serialized working documents
-- with a backlink index. Paths are unique among live (non-archived) rows.

CREATE TABLE working_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path            TEXT NOT NULL,
  type            TEXT NOT NULL,
  frontmatter     JSONB NOT NULL DEFAULT '{}'::jsonb,
  body            TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  section_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  byte_size       INTEGER NOT NULL DEFAULT 0,
  task_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,
  conversation_id TEXT,
  agent_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_working_documents_path_live
  ON working_documents (path)
  WHERE archived_at IS NULL;

CREATE INDEX idx_working_documents_path_prefix_live
  ON working_documents (path text_pattern_ops)
  WHERE archived_at IS NULL;

CREATE INDEX idx_working_documents_task_id_live
  ON working_documents (task_id)
  WHERE archived_at IS NULL AND task_id IS NOT NULL;

CREATE TABLE working_document_links (
  id           BIGSERIAL PRIMARY KEY,
  source_path  TEXT NOT NULL,
  target_path  TEXT NOT NULL,
  link_kind    TEXT NOT NULL CHECK (link_kind IN ('markdown', 'wikilink')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_working_document_links_unique
  ON working_document_links (source_path, target_path, link_kind);

CREATE INDEX idx_working_document_links_target
  ON working_document_links (target_path);

CREATE INDEX idx_working_document_links_source
  ON working_document_links (source_path);

-- Down Migration
DROP TABLE IF EXISTS working_document_links;
DROP TABLE IF EXISTS working_documents;

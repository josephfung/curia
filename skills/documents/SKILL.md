---
name: documents
description: >
  OKF document workspace — doc-read/list/write/search/place for mutable working state
  addressed by path. Pin alongside tasks for resumable project documents.
version: "0.2.3"
document_workspace: true
tools:
  - doc-read
  - doc-list
  - doc-write
  - doc-search
  - doc-place
---

## Document Workspace

You have an OKF document workspace — a filesystem of markdown concept-files addressed
by path. Use your `doc-*` skills to read, list, write, search, and place documents in it.

**Paths.** Documents live at paths like `/projects/<slug>/brief.md` or
`/scratch/<conversation-id>/outline.md`. Directories are path prefixes — `doc-list` on
a prefix is like `ls` on a folder. Each directory has reserved `index.md` (navigation
catalog) and `log.md` (append-only change history). Before you create a new `/projects/`
folder, call `doc-place`: it prefers extending a document or adding to an existing folder,
and names a new folder with a readable kebab-case slug. Shared folders are fine — path is
organisational; ownership is `task_id`.

**Writes.** `doc-write` creates, appends, replaces, or section-edits at a path and
appends a `log.md` entry in that directory. Re-read with `doc-read` after writes that
need the latest `expected_version`. On conflict, merge from the returned document and
retry with the new version.

**Conventions.** YAML frontmatter requires `type`; `title`, `tags`, and `timestamp` are
conventional. Link between documents with markdown path links or `[[wikilinks]]`.
Distill durable conclusions to the knowledge graph via `memory-store` / `extract-facts`
when a project completes — the workspace is for mutable working state, not validated facts.

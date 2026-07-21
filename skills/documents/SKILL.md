---
name: documents
description: >
  OKF document workspace — doc-read/list/write/search for mutable working state
  addressed by path. Pin alongside tasks for resumable project documents.
version: "0.1.0"
document_workspace: true
tools:
  - doc-read
  - doc-list
  - doc-write
  - doc-search
---

## Document Workspace

You have an OKF document workspace — a filesystem of markdown concept-files addressed
by path. Use your `doc-*` skills to read, list, write, and search it.

**Paths.** Documents live at paths like `/projects/<slug>/brief.md` or
`/scratch/<conversation-id>/outline.md`. Directories are path prefixes — `doc-list` on
a prefix is like `ls` on a folder. Each directory has reserved `index.md` (navigation
catalog) and `log.md` (append-only change history).

**Retention.** `/projects/…` documents are durable — they are never auto-purged. Use them
for task work that must survive across days and distillation. `/scratch/<conversation-id>/…`
is ephemeral: the nightly purge removes scratch documents after a period of inactivity
(measured from `updated_at`). Omit `ttl_days` in frontmatter to inherit the configured
scratch default; set `ttl_days: <n>` on a scratch document to override retention, or
`ttl_days: 0` to opt out (prefer `/projects/` for anything that should outlive the
conversation). `ttl_days` on non-scratch paths is ignored.

**Manifest first, bodies on demand.** On resume you may receive a directory manifest
(the `index.md` projection) at the tail of your task message — that is the map, not
the content. Pull document bodies and specific `##` sections with `doc-read` as tool
results so working text stays out of the cached system prefix.

**Writes.** `doc-write` creates, appends, replaces, or section-edits at a path and
appends a `log.md` entry in that directory. Re-read with `doc-read` after writes that
need the latest `expected_version`. On conflict, merge from the returned document and
retry with the new version.

**Conventions.** YAML frontmatter requires `type`; `title`, `tags`, and `timestamp` are
conventional. Link between documents with markdown path links or `[[wikilinks]]`.
Distill durable conclusions to the knowledge graph via `memory-store` / `extract-facts`
when a project completes — the workspace is for mutable working state, not validated facts.

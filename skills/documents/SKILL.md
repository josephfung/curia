---
name: documents
description: >
  OKF document workspace: doc-read/list/write/search/place for mutable working
  state by path. Load when reading or writing project docs; pair with tasks for
  resumable multi-step work.
version: "0.3.0"
document_workspace: true
tools:
  - doc-read
  - doc-list
  - doc-write
  - doc-search
  - doc-place
---

## Document Workspace

You have an OKF document workspace: markdown files addressed by path, used through your
`doc-*` skills.

**Paths.** Documents live at paths like `/projects/<slug>/brief.md` or
`/scratch/<conversation-id>/outline.md`. `doc-list` on a path prefix lists that folder.
Each directory has reserved `index.md` (navigation catalog) and `log.md` (append-only
change history). Before you create a new `/projects/` folder, call `doc-place`: it
prefers extending a document or adding to an existing folder, and names a new folder with
a readable kebab-case slug. Tasks may share a project folder; a project document's owner
is its `task_id`, not its path.

**Shared documents.** `/shared/…` documents are durable and shown under `## Pinned
context`; only an agent that declares one can write it. Follow the format it states at
its top.

**Console-only documents.** A document whose frontmatter has `editable_by: console` is the
console's: leave it unchanged, and never add or remove that key.

**Writes.** Re-read with `doc-read` when you need the latest `expected_version`. On
conflict, merge from the returned document and retry with the new version.

**Conventions.** YAML frontmatter requires `type`; `title`, `tags`, and `timestamp` are
conventional. Link between documents with markdown path links or `[[wikilinks]]`.
The workspace is mutable working state: when a project completes, distill durable
conclusions to the knowledge graph via `memory-store` / `extract-facts`.

# 21 — Agent Document Workspace (OKF)

**Date:** 2026-07-01
**Status:** Shipped (v0.39)
**Builds on:** [spec 01 — Memory System](01-memory-system.md), [spec 19 — Tasks & Backlog](19-tasks-and-backlog.md), [spec 20 — Resumable Tasks & Projects](20-resumable-tasks-and-projects.md)

## Overview

Spec 01 gives an agent four **validated** memory surfaces — working memory, Bullpen,
entity memory, and the knowledge graph — each strict, typed, gated, and durable. None of
them is a good home for *freeform working state that grows*: the running notes of a
multi-day audit, an outline being drafted across bursts, a research dossier assembled step
by step. Working memory compacts away; the KG's `extract-*` gates reject untyped prose;
`config-store` is a small key/value store with no delete; and `tasks.progress` must stay
bounded so it can be read on every wake.

The **agent document workspace** is the fifth surface: a mutable, ungated *thinking space*.
It is a filesystem of markdown documents addressed by path, serialized in the **Open
Knowledge Format (OKF)** and stored in Postgres. It is deliberately loose where the other
tiers are strict — freeform, untyped-beyond-a-`type`-tag, mutable, and un-gated — because
its job is to hold work-in-progress, not durable truth. Curated conclusions still graduate
into the KG through the existing gates (§10); the workspace is the scratchpad, the KG is the
record.

Tracking epic: #1207 (sub-issues #1208–#1212; #1213 deferred). The as-built design memo was
folded into this spec at the v0.39 release.

---

## 1. Why a new surface — the gap

Each existing tier fails a different requirement of a growing working document:

- **Working memory** is summarized/compacted between bursts — long working text does not
  survive intact.
- **Knowledge graph** gates every write through `extract-facts` / `extract-relationships`;
  freeform prose has nowhere to land and would be rejected.
- **`config-store`** is a small key/value store (bounded values, no delete) — wrong shape
  and wrong lifecycle for documents.
- **`tasks.progress`** is read on every wake and must stay bounded (spec 20 §2), so it
  cannot carry the body of the work — only a pointer to it.

The workspace fills exactly this gap, and only this gap. It is not a general datastore and
not a memory tier the KG's consumers read from.

## 2. The OKF model

Documents are **markdown with a YAML frontmatter header**. The format is decoupled from
storage: agents read and write an OKF-serialized document; the bytes live in Postgres, not
on a filesystem. The serialization helpers live in `src/memory/okf.ts` (`docDirectory`,
`normalizeDocPath`, `splitSections`, `markdownFenceFor`).

- **`type` is the only required frontmatter field.** `title`, `tags`, and `timestamp` are
  conventional; `ttl_days` is meaningful on scratch paths (§9).
- **Path is identity.** A document is addressed by its path (e.g. `/projects/kickoff/brief.md`);
  there is at most one live document per path (§4).

## 3. Path addressing & conventions

Paths are POSIX-like and directories are just prefixes, so `doc-list` on a prefix behaves
like `ls` on a folder.

- **`/projects/<slug>/…`** — durable working documents. Never auto-purged; the home for work
  that must survive across days and feed distillation.
- **`/scratch/<conversation-id>/…`** — ephemeral. Swept by the nightly purge after a period
  of inactivity (§9). The reserved shape is `/scratch/<conversation-id>/<leaf>`
  (`SCRATCH_CONVERSATION_PATH_RE`, `src/agents/document-workspace.ts`).
- **Reserved leaves.** Every directory has an `index.md` (a navigation catalog) and a
  `log.md` (an append-only change history). These names are reserved — generic
  create/replace will not overwrite them (`RESERVED_LEAF_NAMES`).

## 4. Data model

Two tables, added in **migration 066** (`src/db/migrations/066_create_working_documents.sql`):

- **`working_documents`** — `id`, `path`, `type`, `frontmatter` (JSONB), `body`, `version`,
  `section_versions` (JSONB, per-`##`-section optimistic-concurrency counters), `byte_size`,
  nullable `task_id` (FK → `tasks`, `ON DELETE SET NULL`), `conversation_id`, `agent_id`,
  `created_at`, `updated_at`, and `archived_at`.
- **`working_document_links`** — the backlink index: `source_path`, `target_path`, and
  `link_kind` (`CHECK IN ('markdown', 'wikilink')`).

Uniqueness is enforced only among **live** rows: a partial unique index
`idx_working_documents_path_live ON (path) WHERE archived_at IS NULL` allows a path to be
reused after its previous document is archived. A `text_pattern_ops` prefix index backs
`doc-list`, and the links table carries unique `(source, target, kind)` plus source/target
lookup indexes.

## 5. `WorkingDocsRepo` & the backlink index

`WorkingDocsRepo` (`src/db/working-docs-repo.ts`) is the single read/write path. On each
write it parses frontmatter and re-extracts outgoing links (markdown path links and
`[[wikilinks]]`) into `working_document_links`, so "what links here" is a plain lookup on
`target_path`.

Writes are **optimistically concurrent**: a caller passes an `expected_version` (whole
document) or a section version, and a mismatch returns the current document as data
(`conflict: true`) rather than throwing or silently clobbering. Section-level versioning
(`section_versions`) lets two agents edit different `##` sections of the same document
without a false conflict.

## 6. Skills (#1209)

Four skills, auto-pinned into every workspace-enabled agent (§7):

| Skill | `action_risk` | Version | Behavior |
|---|---|---|---|
| `doc-read` | none | 0.1.0 | Read a document, or one `##` section (section-heading match is **case-insensitive**). |
| `doc-list` | none | 0.1.0 | List documents under a path prefix — the `index.md` projection of a directory. |
| `doc-search` | none | 0.1.0 | **Case-sensitive substring** grep across bodies (`line.includes(query)`); `path_prefix` defaults to the whole workspace; capped at 50 matches. |
| `doc-write` | low | 0.2.0 | Create / append / replace / section-edit at a path; appends a `log.md` entry; returns `conflict: true` on version mismatch. |

`doc-write` carries `action_risk: low` (an internal-state write); the three read skills are
`action_risk: none`.

## 7. Harness injection & auto-pin

The workspace is exposed the same way the resumable and plan harnesses are: a fixed-slot
guidance block plus dynamically-pinned skills, injected by `applyDocumentWorkspace`
(`src/agents/document-workspace.ts`). Injection is gated on the existing
**`task-management`** skill — there is no separate document-workspace flag — so the
`DOCUMENT_WORKSPACE_BLOCK` and the four `doc-*` skills are added only to task-management
agents, appended after the task-management block (call site in `src/index.ts`).

The guidance block teaches the path conventions, retention rules, and **manifest-first**
discipline: on resume an agent may receive the directory manifest (the `index.md`
projection) at the **tail** of its task message, then pull document bodies and specific
sections via `doc-read` as tool results — keeping working text out of the cached
tools/system prefix so prefix caching survives across providers (the same discipline spec
20 §3 applies to the resumable nudge).

## 8. Accumulator spill (#1210)

The resumable accumulator (spec 20 §2) is bounded — a 4 KB inline cap
(`RESUMABLE_INLINE_ACCUMULATOR_MAX_BYTES = 4096`) and an 8 KB block cap
(`RESUMABLE_BLOCK_MAX_BYTES = 8192`). On overflow it spills into the workspace at
`/projects/<root-task-id>/accumulator.md` (`type: resumable-accumulator`), and
`progress.resumable` stores a `{ kind: 'document', path, section? }` pointer
(`isDocumentPointer`, `src/db/resumable-progress.ts`) in place of the inline text. This is
the workspace's first production consumer: unbounded working output has a durable home
without bloating the task row.

## 9. Retention — the `/scratch` TTL sweep (#1212)

`/projects/…` documents are durable and never auto-purged. `/scratch/<conversation-id>/…`
documents are swept by the DreamEngine nightly pass (`src/memory/dream-engine.ts`), which
invokes `WorkingDocsRepo.purgeExpiredScratch` (`src/db/working-docs-repo.ts`). There is **no
`expires_at` column** — expiry is derived from
`updated_at` plus the configured TTL, so any write refreshes the clock. A per-document
`ttl_days` in frontmatter overrides the default: `0` opts the document out of the sweep,
`1`–`36500` sets an explicit window, and `ttl_days` on a non-scratch path is ignored.
Defaults and bounds live in `document-workspace.ts` (`DEFAULT_SCRATCH_DOC_TTL_DAYS = 7`,
`MAX_SCRATCH_DOC_TTL_DAYS = 36500`).

## 10. Distillation to the knowledge graph (#1211)

Curated conclusions graduate from the workspace into the KG on a planned parent's
completion, owned by spec 20 §7 (`DeliverableKgPromotionSubscriber`): the **curated
deliverable** — never the per-item worklog — is distilled through the existing
`extract-facts` / `extract-relationships` gates, capped per project, best-effort and
non-fatal, after which the project's workspace documents are archived (`archived_at`). The
workspace is the source; the KG is the durable sink.

## 11. Configuration

```yaml
documentWorkspace:
  scratchTtlDays: 7          # default /scratch inactivity TTL; positive integer ≤ 36500
  kgPromotion:
    enabled: true            # global on/off for deliverable → KG distillation (§10)
    maxFacts: 50             # per-project cap
    maxRelationships: 50     # per-project cap
```

Validated in `src/config.ts`: `scratchTtlDays` must be a positive integer ≤ 36500;
`kgPromotion.maxFacts` / `maxRelationships` are non-negative integers.

## 12. Deferred (post-v0.39)

- **#1213 — OKF-bundle export + static-HTML visualizer.** Exporting a project's documents
  as a portable OKF bundle and rendering a browsable static site. Kept open (not
  `wontfix`); out of scope for this release. The orphan/stale/contradiction lint sketched
  in the design memo was dropped as WIP noise, and full CRDT/locking remains out of scope —
  the optimistic-concurrency model in §5 is the concurrency story.

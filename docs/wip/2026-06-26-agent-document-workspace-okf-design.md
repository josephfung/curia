# Agent Document Workspace (on the Open Knowledge Format) — Design

**Date:** 2026-06-26
**Status:** Draft — OKF format accepted as the direction; backing store recommended (Postgres), not locked. Decomposed into v0.39 epic [#1207] (sub-issues [#1208]–[#1213])
**Builds on:** [spec 01 — Memory System](../specs/01-memory-system.md), [resumable tasks & projects design](2026-06-23-resumable-tasks-and-projects-design.md), [spec 19 — Tasks & Backlog](../specs/19-tasks-and-backlog.md)

## Context — the gap

Agents working on **longer-running projects** (the whole v0.39 milestone is "Resumable
Tasks & Projects") need a place to keep rich, mutable, freeform *working state*: a project
brief, a running outline, an accumulating findings list, a decision log, intermediate
analysis. State that survives across many executor invocations and that a resumed burst
re-reads to continue. None of today's memory primitives is the right shape for this:

- **Working memory** (`src/memory/working-memory.ts`, table `working_memory`) holds
  conversation *turns*, scoped to `(conversation_id, agent_id)`, and is **designed to
  compact away** — rolling summarization archives older turns at ~20 turns (spec 01,
  "Context Summarization"). It is a transcript, not a document.
- **Knowledge graph / entity memory** (`src/memory/knowledge-graph.ts`,
  `src/memory/entity-memory.ts`) stores atomic, **validated** facts with embeddings and
  decay. Its gates — dedup ≥0.92 cosine, contradiction detection, rate-limit, source
  attribution (spec 01, "Memory Validation Gates") — exist precisely to keep freeform,
  evolving, contradictory working text *out*. A mutable project brief fights every gate.
- **Config-store** (`src/memory/config-store.ts`) is namespaced key/value **stored as KG
  facts**: a ~2000-char value cap, no delete, and the same dedup/confidence path. Fine for
  a watermark; wrong for a growing document.
- **`tasks.progress` JSONB** (`src/db/task-repo.ts`) carries the resumable design's
  `resumable` block (cursor, done/total, accumulator, next-step). That block is meant to
  stay **small and bounded** — the design explicitly says the accumulator "must be bounded
  (cap + spill to storage) so a long job cannot bloat the JSONB."

That last point is the precise connection. The resumable-tasks design leaves an open
question:

> *"Accumulator bounding policy (cap size, spill target) and whether large accumulators
> reuse an existing storage surface or need a new one."*

Issue [#1172] currently proposes spilling to config-store. This document argues the
accumulator's spill target — and, more broadly, the **project's working document** — wants
a new surface, and that the right shape for that surface is a **document workspace** that an
LLM manipulates instinctively.

## Don't invent a model — adopt the Open Knowledge Format

The instinct was a filesystem of markdown documents with paths and cross-links. That exact
pattern has just been formalized as an open standard, so we should adopt it rather than
reinvent it:

- **Open Knowledge Format (OKF)** — Google's vendor-neutral v0.1 standard
  ([announcement](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)).
  An OKF *bundle* is a directory of markdown files, each representing one **concept**, where:
  - **the file path is the concept's identity**;
  - **YAML frontmatter** carries queryable metadata (only `type` is required; `title`,
    `description`, `tags`, `timestamp`, `resource` are conventional);
  - **markdown links** between files form a graph "richer than the parent/child links
    implied by the file system," and broken links are tolerated;
  - reserved **`index.md`** (a navigable catalog) and **`log.md`** (append-only history)
    files aid navigation and change-tracking.

  The spec fits on a page, requires no SDK, and ships reference implementations including a
  static-HTML graph **visualizer**. Crucially it is *"a format, not a platform... readable
  in any editor, mountable on any filesystem, hostable in any git repo."*

- **LLM-Wiki** (Karpathy, the pattern OKF formalizes —
  [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)) frames *why*
  this shape suits LLMs and gives the operating model: three layers —
  **immutable raw sources** / an **LLM-owned mutable wiki** (markdown + `[[wikilinks]]` +
  frontmatter + `index.md`/`log.md`) / a **schema/contract** doc defining conventions — and
  a loop of **ingest** (write/update pages, cascade cross-references), **query** (read pages,
  file answers back), and **lint** (find contradictions, stale claims, orphans). The
  rationale: *"LLMs don't get bored, don't forget to update a cross-reference, and can touch
  15 files in one pass. The bookkeeping that causes humans to abandon personal wikis is
  exactly what LLMs are good at."*

Why this fits Curia almost one-to-one:

| LLM-Wiki layer / operation | Curia mapping |
|---|---|
| Immutable raw sources | Inbound messages, emails, the `audit_log`, the task's intent anchor — already immutable |
| LLM-owned mutable wiki | **The new document workspace** (this design) |
| Schema / contract | Harness-injected guidance + agent config (the existing "no project foresight" mechanism) |
| ingest / query | Agent reads/appends workspace docs as it works across resumed bursts |
| lint | `DreamEngine`'s nightly pass already does decay/purge — extend it to orphan / stale / contradiction checks |
| promote to durable facts | Distill workspace → KG via `extract-facts` / `extract-relationships` (through the validation gates) |

The single most useful idea OKF contributes is **format ≠ platform**. We can let the agent
read and write what *is* an OKF bundle while storing the bytes wherever serves the
deployment best (see "Backing store"). That separation dissolves most of the
"table vs. files vs. external app" tension.

## The model — an OKF-conformant document workspace

A new, system-wide memory facility presented to agents as a small OKF bundle: a filesystem
of markdown concept-files, addressed by path, connected by links. (Curia's *own* agent
memory — file-per-fact plus a `MEMORY.md` index plus `[[name]]` cross-links — is a working
demonstration that LLMs wield this shape naturally.)

1. **OKF documents.** Each document is one markdown file with YAML frontmatter (`type`
   required; `title` / `description` / `tags` / `timestamp` conventional). The body is
   freeform markdown with addressable `##` sections.

2. **Path addressing, implicit directories.** Documents live at paths such as
   `/projects/<slug>/brief.md`, `/playbooks/sales-kickoff.md`,
   `/scratch/<conversation-id>/outline.md`. Directories are derived from path prefixes
   (`ls /projects/x/` ≡ a prefix match) — there is no separate directory object to maintain.
   A reserved `index.md` per directory gives navigation; a `log.md` gives append-only
   history.

3. **Cross-document linking + backlinks.** Both markdown path links
   (`[findings](/projects/x/findings.md)`) and `[[wikilinks]]` (resolved relative to the
   current document's directory). The store maintains a lightweight **backlink index** so
   the workspace is a navigable graph and "what links here" is cheap. Broken links are
   tolerated, per OKF.

4. **Unscoped and system-wide.** A document is **not** bound to a task. Association is
   *convention* — a path prefix like `/projects/<slug>/…` or `/scratch/<conversation-id>/…`
   — plus *optional* nullable references (`task_id`, `conversation_id`) used only for
   querying and cleanup, never as a required scope. Some projects need zero documents; some
   need many; some standing documents (a playbook, a reference) belong to no task at all.
   A resumable task's accumulator simply stores a **path** pointer into the workspace.

5. **Two complementary graphs.** The workspace is the **loose, untyped, mutable, ungated**
   thinking surface (OKF wikilinks). The **knowledge graph** remains the **strict, typed,
   validated, durable** fact store. The two are bridged by **distillation**: when a project
   completes, its workspace is fed to the existing `extract-facts` /
   `extract-relationships` infrastructure, so durable conclusions land *typed and gated* in
   the KG while the freeform working text never had to fight the gates. This is the clean
   division of labor — **workspace = where thinking happens; KG = what we durably believe.**

### A concrete document

```markdown
---
type: project-brief
title: Bluesky follow audit
tags: [social-media, audit]
timestamp: 2026-06-26T14:30:00Z
task_id: 1f9c…
---

# Goal

Page through ~1,300 follows, unfollow the obvious ones, email back the flagged set.

# Progress

312 / 1300 reviewed. See [[findings]] for the running flagged list.
Cursor + counts live in the task's resumable block; this doc holds the *why*.

# Decisions

- Treat "no posts in 18 months + 0 mutuals" as auto-unfollow. (2026-06-26)
- Anything with a mutual goes to [findings](/projects/bluesky-audit/findings.md) for review.
```

On resume, the agent is handed the directory's `index.md` manifest, re-reads `brief.md`,
appends to `findings.md`, and continues — exactly the LLM-Wiki *query → ingest* loop, with
no project-specific code in the agent's authored config.

## Backing store — recommended, not locked

OKF is the format the *LLM* reads and writes; where the bytes live is a separate decision.
The format/platform split means we can choose storage on operational merits without
compromising the model the agent sees.

- **(A) Postgres, OKF-serialized — recommended.** Rows keyed by `path`; frontmatter parsed
  into columns / JSONB; body stored as markdown; links extracted into a backlink table.
  Consistent with every other Curia memory tier (Postgres + pgvector), transactional and
  multi-process-safe (the resume loop deliberately wakes overlapping bursts — see
  "Concurrency" below), covered by existing backups, keeps sensitive working text
  in-system, and sidesteps container-filesystem fragility we have already been bitten by
  (stale Chrome `SingletonLock`, OAuth-volume repointing under the non-root migration). The
  agent still sees an OKF bundle; the database is merely the store.

- **(B) Flat OKF files on a mounted volume.** Maximal fluency and natively OKF (a real
  directory the visualizer reads directly), but fights deployment realities: ephemeral /
  volume storage, multi-process concurrency, backup and sandboxing story, and the non-root
  volume issues already on record. Best treated as an **export target**, not the source of
  truth.

- **(C) External app (Notion / Obsidian).** Obsidian is essentially markdown + wikilinks
  (≈ B plus a GUI). Notion adds a friendly UI and an API but introduces a third-party
  dependency and, more seriously, **sensitive-data egress** to an outside service — at odds
  with the security posture. Best framed as an **optional future mirror / UI** layered over
  (A), never the system of record.

- **Export, regardless of store.** Because the workspace is OKF-conformant, store (A) can
  emit a real OKF bundle (tarball or git repo) on demand. That unlocks human viewing, the
  free static-HTML graph visualizer (a self-contained artifact — no backend), and any
  emerging OKF/MCP consumer, without making files the system of record.

**One line:** adopt the OKF *format*, store it in *Postgres*, and *export* OKF bundles for
interoperability and visualization.

## Access surface (sketch — non-binding)

Filesystem-familiar verbs, so usage is reflexive for the LLM. Final skill specs are out of
scope for this addendum; the shape:

| Verb | Behaviour | Notes |
|---|---|---|
| read | Read a document by path; optional `section` | Section reads keep per-burst context cost down |
| write | Create / append / replace / section-edit at a path | Appends a `log.md` entry; create-on-missing |
| list | List a path prefix ("ls a directory") | Returns the `index.md` projection |
| search | Grep + optional semantic search across the workspace | See "Lifecycle" for the embedding question |
| (later) move / delete / export | Rename, soft-delete, emit an OKF bundle | |

These would follow Curia's skill conventions (`{ success, data } | { success, error }`,
`action_risk`, capability gating — reads `none`, writes `low`, matching `memory-store` /
`config-store`) and be taught via **harness-injected guidance + auto-pinning** — the same
mechanism as the principal-contact block and the resumable-task guidance — so agent authors
write nothing project-specific (the resumable design's "no project foresight" principle).

## Lifecycle

- **History.** `log.md` per directory is the append-only change record (LLM-Wiki's
  parseable `## [date] <op> | <summary>` convention), complementing — not replacing — a
  row-level revision trail in the store. Mirrors the audit-log append-only philosophy.
- **Retention.** Project documents are permanent until the project terminates, then
  retained for audit (opposite of working-memory's TTL purge). `/scratch/<conversation-id>`
  documents get a TTL and are swept by the existing `DreamEngine` purge path.
- **Size & compaction.** Soft caps on document body and per-directory document count; on
  overflow the agent is nudged to compact its own document (agent-driven, so freeform
  nuance isn't lost to a generic summarizer). LLM-Wiki's "synthesis decay" caution applies:
  anchor durable claims to immutable sources, and lean on append-only `log.md` to preserve
  the trail.
- **Search.** Start with prefix/`grep`. Add semantic search only if needed; documents are
  mutable, so embed lazily / on a schedule rather than on every write (spec 01 already
  notes the read-path doesn't re-embed). The LLM-Wiki comments converge on the same answer
  (FTS first, optional embeddings, bounded graph retrieval).
- **Lint.** Extend `DreamEngine`'s nightly job to flag orphans, stale documents, and
  obvious contradictions — the LLM-Wiki *lint* step, reusing machinery we already run.
- **Distillation.** On project completion (`completeTask`), best-effort and non-fatal: feed
  the workspace through `extract-facts` / `extract-relationships` so durable facts land in
  the KG *through* the validation gates, then archive the documents.

## Path to v0.39

Decomposed into a dedicated epic, [#1207] — **Agent Document Workspace (OKF)** — with six
sub-issues on milestone v0.39, plus amendments to the resumable-tasks issues. It complements
the resumable epic [#1150] (it supplies the spill target) but does not gate its close
condition.

**Core (P2)**

- [#1208] (W1) — OKF store, repo, and backlink index (the `working_documents` /
  `working_document_links` migration, `WorkingDocsRepo`, frontmatter + link parsing).
- [#1209] (W2) — `doc-read` / `doc-list` / `doc-write` / `doc-search` skills + harness-
  injected workspace guidance and auto-pin.
- [#1210] (W3) — spill the resumable accumulator into a workspace document; stores a
  `{ kind: "document", path, section? }` pointer in `progress.resumable`. Depends on
  [#1208] and [#1172].

**Follow-ups (P3/P4)**

- [#1211] (W4) — distill a completed workspace into the KG via the existing
  `extract-facts` / `extract-relationships` validation gates.
- [#1212] (W5) — nightly `DreamEngine` lint (orphans / stale / contradictions) + `/scratch`
  TTL sweep.
- [#1213] (W6) — OKF-bundle export + the static-HTML visualizer.

**Amendments applied:** [#1172] — accumulator spill target changed from config-store to a
workspace path pointer (implemented in [#1210]); `#1172` can still ship inline-cap-only
first. [#1173] — its injected resumable-task guidance composes with the workspace guidance
([#1209]). [#1150] — cross-referenced to this epic.

**Ordering:** [#1208] is the foundation; everything else depends on it. [#1210] also depends
on [#1172]'s pointer shape and should land before / with [#1173] (the `checkpoint`
primitive), which injects the document manifest into its resumable-task guidance.

## Open questions

- **OKF conformance depth.** Full v0.1 conformance (so external OKF tooling — visualizer,
  MCP servers — consumes the workspace unchanged) vs. an "OKF-inspired" subset. Recommend
  full conformance; the cost is low (it's just markdown + frontmatter conventions).
- **Backing store.** (A)/(B)/(C) above — (A) recommended but explicitly open for
  discussion. This is the main thing left to decide.
- **Concurrency.** The resume loop wakes overlapping bursts and a planned step dispatches
  multiple children per wake, so two writers can touch one document. Mitigate with
  optimistic versioning (`expected_version`, conflict surfaced as data not error — the
  `memory-store` pattern) plus section-level edits so different sections never collide.
  Full CRDT/locking is out of scope.
- **Per-burst context cost.** Loading documents each burst tensions with `#1173`'s
  prompt-cache discipline ("volatile data at the message tail, never in the cached prefix").
  Mitigate by injecting only the `index.md` manifest by default and letting the agent pull
  bodies (and specific sections) via `read` as tool results at the tail.
- **Embedding strategy** for mutable documents (lazy vs. scheduled vs. none-at-launch).
- **Distillation trigger** — automatic on completion vs. explicit agent/CEO action.
  Recommend automatic-but-non-fatal, with a disable flag.
- **`memory.scopes` (#521)** is parsed but inert today. Keep the workspace decoupled from
  it; `agent_id` is the forward-compat hook if scopes ever activate as a real isolation
  boundary.
- **Maturity risk** of betting on OKF v0.1 (young, Google-published). Commitment is small
  — if the standard stalls we still have a sane, self-contained markdown format — and the
  loose untyped-wiki model stays cleanly complementary to the strict, typed KG.

[#521]: https://github.com/josephfung/curia/issues/521
[#1150]: https://github.com/josephfung/curia/issues/1150
[#1172]: https://github.com/josephfung/curia/issues/1172
[#1173]: https://github.com/josephfung/curia/issues/1173
[#1207]: https://github.com/josephfung/curia/issues/1207
[#1208]: https://github.com/josephfung/curia/issues/1208
[#1209]: https://github.com/josephfung/curia/issues/1209
[#1210]: https://github.com/josephfung/curia/issues/1210
[#1211]: https://github.com/josephfung/curia/issues/1211
[#1212]: https://github.com/josephfung/curia/issues/1212
[#1213]: https://github.com/josephfung/curia/issues/1213

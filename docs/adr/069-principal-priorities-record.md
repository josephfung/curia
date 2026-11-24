# ADR-069: The principal's priorities are a pinned document, and the deep dive's writes go through their owners

Date: 2026-11-23
Status: Accepted

## Context

Curia should weigh its work and suggestions against what the principal is trying to move, and
keep that current as goals change (#2362). Until now nothing held the principal's goals as such.
They surfaced, if at all, as knowledge-graph facts that `extract-facts` happened to keep from a
conversation: partial, unordered, with no "current" or "superseded" state and nothing the
principal could read and correct in one place.

The onboarding deep dive (#2362) adds a second reason to settle this. It reads about 90 days of
the principal's mail and calendar once, and drafts three documents for the principal to review:
working rules, where the time went ("what are you trying to move?"), and writing voice. Each
confirmed draft has to land somewhere agents actually work from, written by something already
allowed to write it, without a new system-side write path for each.

Spec 20 says "the workspace is the scratchpad, the KG is the record". That was right for agents'
working notes, but ADR-056 has since made `/shared/` documents durable, principal-owned and
console-editable, and some of them (the scheduling rules, the inbox rules) already *are* the
record of a standing choice. Priorities are the same kind of thing.

Alternatives considered for priorities:

1. **Knowledge-graph facts only.** No ordering, no "as of", no single place the principal edits,
   and every agent would need a query to find them. Rejected.
2. **One pinned document holding current and past priorities.** Simple, but the pin renders the
   whole document on every coordinator turn, so its per-turn cost grows for as long as the
   principal uses Curia. Rejected.
3. **A write-only pin** (a `pinned_context` option granting write permission without rendering
   the document) for the past priorities. Rejected: a configuration option that grants writes
   without context invites misconfiguration, and it is not needed (see Decision).
4. **Two documents: the current one pinned, past ones unpinned (chosen).**

## Decision

### Priorities live in two documents

- **`/shared/principal/priorities.md`: current priorities only, pinned by the coordinator.**
  Its `pinned_context` entry carries the behaviour in its description: weigh work and suggestions
  against the priorities, ask before updating when the principal states or changes a goal, move superseded
  ones to the past document, and offer to start the document when goals come up and it does not
  exist. A newly created document starts with standard frontmatter (`src/memory/priorities-doc.ts`):
  `as_of` (updated on every change), `past:` (where superseded ones go) and a one-line `format`.
  It is kept small, so the pin's per-turn cost stays roughly fixed.
- **Past priorities: a separate, unpinned document outside `/shared/`.** Default
  `/meetings/principal/priorities-past.md`, a durable prefix (ADR-056), so it is never archived
  with a task or expired as scratch. Being outside `/shared/`, the pin-to-write guard does not
  apply, and the coordinator writes it with plain `doc-write`; no schema change. It is read when
  history comes up ("what was I focused on in the spring?") and is the natural home for goal
  tracking later.
- **The location is not hardcoded into behaviour.** The current document's `past:` field names
  the past document, and that pointer is what the coordinator follows. The default only seeds the
  field on creation.
- **Only the coordinator pins it.** ceo-inbox and calendar do not; they get priorities through
  the coordinator's briefs. Pinning them elsewhere is a separate decision with its own per-turn
  cost.

### The document is the record; knowledge-graph facts are context

For priorities, the document is what is true. `extract-facts` and `memory-store` are unchanged,
so the knowledge graph may still hold goal-related facts from conversation, but those are context
and lose to the document when they disagree. The coordinator writes the document only when the
principal agrees (it proposes; the principal confirms or edits). The principal can also edit it in
the console at any time: it is not marked `editable_by: console`, because the coordinator must be
able to write it too.

### Spec 20: durable, principal-owned documents can be the record

Spec 20's "the workspace is the scratchpad, the KG is the record" is revised: it holds for
agents' working documents, while a durable, principal-owned `/shared/` document (the rules
documents, the priorities) is the record of what it holds, and the knowledge graph is context
for it.

### The deep dive's summary and drafts are sensitive

The history summary is built from private mail and calendar, and the drafts are built from the
summary. So:

- **They stay in Curia.** The summary and drafts are durable working documents under
  `/meetings/onboarding/deep-dive/`; nothing pins them, and they are edited only in the console
  (`editable_by: console`), so no agent turn rewrites them.
- **Google Docs during review are shared with the principal.** For the review, the coordinator
  copies each draft into a Google Doc and shares it with the principal's verified address; the
  skill guidance treats draft text as data, never instructions. There is no source-specific Drive
  guard: an injected share would have to get past the inbound checks and the outbound judges,
  which is where that defence lives. After import, the Google Doc is marked as moved to Curia;
  the Curia copy is the one that counts.

### Each confirmed draft is written by whoever already owns it

No new system code writes these documents. On the principal's confirmation:

- **Working rules** are imported by delegation: the inbox rules to ceo-inbox and the calendar
  rules to calendar, as "add these confirmed rules". Each agent writes its own pinned rules
  document in its own format and merges against what is already there. The coordinator does not
  pin the rules documents: a pin is the write permission *and* renders the whole document on every
  coordinator turn.
- **Writing voice** is written by `executive-profile-update`, which gains two optional inputs:
  `guide` (so the draft's guide is kept rather than replaced by the current one) and `note` (so
  the version row records that the deep dive seeded it).
- **Priorities** are written by the coordinator with `doc-write` under its pin, as above.

## Consequences

- **The coordinator sees the principal's priorities on every turn** and can name the relevant
  one when it suggests something, at the cost of one small document per turn. The cost stays
  bounded only while superseded priorities really move out; the frontmatter's `format` line and
  the pin's description both say so.
- **Past priorities cost nothing per turn**, and nothing new in the schema or `pinned_context`.
  They are found only through the `past:` pointer, so a document whose pointer is removed or wrong
  loses its history link until the principal or coordinator fixes it.
- **Two sources can disagree.** A knowledge-graph fact can contradict the document. The
  document wins, by this ADR, and nothing reconciles the two automatically.
- **Writes stay with their owners.** The deep dive adds no write path for rules, voice or
  priorities, so the existing guards (the rules agents' merge rules, the executive profile's
  version history, the `/shared/` pin guard) all still apply.
- **Google Drive holds a copy of private material during review.** It is shared with the
  principal; the Curia copy is the record afterwards.
- **ceo-inbox and calendar do not weigh against priorities directly.** If that is wanted, it is a
  later pin with its own per-turn cost.

# Plan: move dedup exclusions off KG facts onto `contact_dedup_exclusions` (#1625)

Date: 2026-09-01
Issue: #1625 (follow-up from #1623 / PR #1624)

## Goal

Dedup exclusions ("these two contacts are not the same person") are an operational
decision, not learned knowledge. Move them from KG fact nodes to a first-class
relational table so they work for contacts with `kg_node_id = NULL`, get FK
integrity, and stop fighting embedding dedup / contradiction detection.

## Steps

1. **Migration `084_contact_dedup_exclusions.sql`**
   - `contact_dedup_exclusions (contact_a_id, contact_b_id, decided_at, decided_by)`
     with `PRIMARY KEY (contact_a_id, contact_b_id)`, `CHECK (contact_a_id < contact_b_id)`,
     both FKs `ON DELETE CASCADE`, plus an index on `contact_b_id`.
   - Backfill from KG `dedup_exclusion` fact nodes: fact node -> `kg_edges` (either
     direction) -> entity node -> `contacts.kg_node_id`; other side is
     `properties->>'value'` cast to uuid, guarded by a UUID regex and an existence
     check on `contacts`. Normalize with LEAST/GREATEST, `ON CONFLICT DO NOTHING`.
   - Old fact nodes are left in place (archived, not deleted) — no dual-write.

2. **`src/contacts/dedup-exclusions.ts`** — replace the KG read/write helpers with
   pure ordered-pair normalization (`normalizeExclusionPair`) reused by the service,
   the backend, and tests. `canonicalPairKey` in `dedup-pair-key.ts` stays the
   task-tag key; normalization returns the ordered tuple the table stores.

3. **`ContactServiceBackend` + both backends** — add
   `addDedupExclusion`, `hasDedupExclusion`, `listDedupExclusions`,
   `reattachDedupExclusions`. Postgres uses parameterized SQL; the in-memory
   backend mirrors the same semantics for unit tests.

4. **`ContactService`** — public `addDedupExclusion(a, b, decidedBy)`,
   `hasDedupExclusion(a, b)`, `listDedupExclusionPairKeys()`. `mergeContacts`
   calls `backend.reattachDedupExclusions(secondaryId, primaryId)` alongside
   `reattachIdentities` / `reattachAuthOverrides`.

5. **`contact-dedup-exclude` tool** — write to the table via `ctx.contactService`;
   drop the `entityMemory` capability and the per-side KG branching. Outputs become
   `excluded` / `already_excluded`. Version 0.1.1 -> 0.2.0.

6. **`contact-find-duplicates` tool** — bulk-load exclusion pair keys once per run
   from `ctx.contactService`; drop the `entityMemory` capability and the facts
   cache. Version 2.1.0 -> 2.2.0.

7. **`scripts/dedup-contacts.ts`** — `DedupRunOptions.getFacts` becomes
   `hasExclusion(aId, bId)`; CLI wires it to `contactService`.

8. **`agents/contacts.yaml`** — reword the `skipped_excluded` line (no longer "a
   dedup_exclusion fact"). Version 0.12.1 -> 0.12.2.

9. **ADR-039** — ledger-vs-KG boundary rule, why exclusions leave the KG, rejected
   alternatives, and the still-open KG same-name node identity problem. Index row
   in `docs/adr/README.md`.

10. **Follow-up issue** for KG same-name node identity, linked from the ADR.

11. **Tests** — null-node pairs, idempotent re-exclude, ordered-pair normalization,
    cascade on contact delete, re-point + renormalize on merge, sweep/find-duplicates
    skipping table-backed exclusions, backfill migration integration test.

12. **CHANGELOG** entries under `[Unreleased]`. No package.json bump (release-only).

## Out of scope

- Removing `StoreFactOptions.multiValued` or its validation exemptions (#1624 stays).
- Fixing KG same-name node identity (separate issue, named in the ADR).

# ADR-039: Operational decisions belong in the relational ledger, not the knowledge graph — dedup exclusions as the first instance

Date: 2026-09-01
Status: Accepted

## Context

Curia keeps two long-lived stores of what it knows:

- **The relational ledger** — Postgres tables. Exact, permanent, transactional, with
  foreign keys and cascades. `contacts`, `tasks`, `autonomy_action_log`, and friends.
- **The knowledge graph** — `kg_nodes` / `kg_edges`. Fuzzy, embedded, confidence-scored,
  decaying, deduplicated by cosine similarity, and with contradiction detection between
  facts that share an `attribute`.

Nothing has said out loud which store a given piece of state belongs in. Dedup exclusions
picked the wrong one, and the resulting bugs are what prompted writing this down.

### What a dedup exclusion is

When the dedup sweep proposes that two contacts are the same person and the CEO says
"no, they are two different people", we record that ruling so the pair is never proposed
again. Since #1027 / PR #1040 it was stored as a pair of KG fact nodes — one on each
contact's entity node — with `properties.attribute = 'dedup_exclusion'`,
`properties.value = <the other contact's id>`, `decayClass: 'permanent'`, and
`confidence: 1.0`.

### Every KG mechanism it touched had to be disabled

The `permanent` decay class and the pinned `confidence: 1.0` are the first tell: the fact
had to opt out of the two mechanisms that make the KG a knowledge graph. The rest followed:

- **Node prerequisite.** A fact must hang off an entity node. KG node identity is keyed on
  `(lower(label), type)`, and `idx_contacts_kg_node_unique` allows one contact per node, so
  when two contacts share a display name the second one is created with `kg_node_id = NULL`
  by design (`createContact` retries without the link on collision). Two contacts with the
  same display name are *exactly* the pairs the dedup sweep proposes most often — and
  neither of them could hold an exclusion. In #1623 the Seth Berman pair had `NULL` on both
  sides, `contact-dedup-exclude` had nowhere to write, and the review task closed anyway.
- **Embedding dedup-merge.** `dedup_exclusion: <uuid-1>` and `dedup_exclusion: <uuid-2>`
  are ~0.99 cosine neighbours: near-identical strings differing only in a UUID the
  embedding model cannot meaningfully distinguish. The validator read the second exclusion
  as a restatement of the first and merged them, silently dropping a ruling.
- **Contradiction detection.** Two facts on the same entity with the same `attribute` and
  different `value`s are, to the validator, a contradiction — which is correct for
  `role` or `organization` and wrong for an attribute that is inherently multi-valued. A
  contact excluded against three different people has three simultaneously-true exclusions.
- **Cost.** Two nodes and two edges per pair, O(n²) inside a same-name cluster, and every
  later fact write on those entities walks each edge for the cosine dedup check.

PR #1624 landed the interim fix: a domain-agnostic `StoreFactOptions.multiValued` flag that
exempts a fact from contradiction detection and embedding dedup-merge, plus a prompt gate
so the contacts agent stops closing the review task when the exclude call fails. That made
multi-person clusters work. It could not fix the null-node case, because nothing about a
flag on a fact write conjures an entity node to write the fact onto.

### The shape mismatch underneath all four

A KG fact is an **attribute of one entity**, learned from observation, held with some
confidence, and expected to age. A dedup exclusion is a **relation between two contacts**,
produced by a review workflow, exact, and expected to hold forever. It is not something
Curia learned about a person; it is something the review process decided about a pair.

## Decision

**Operational decisions and workflow state live in the relational ledger. Learned, fuzzy,
decaying knowledge lives in the knowledge graph.**

The test to apply when adding new state: *did a process decide this, or did Curia learn
it?* A decision is exact, needs to be enforceable, has provenance rather than confidence,
and must not decay, dedupe, or contradict — it gets a table. Learned knowledge is
approximate, benefits from embedding-space neighbourhood search, and should lose
confidence as it ages — it goes in the KG. If a candidate needs `decayClass: 'permanent'`
and `confidence: 1.0` and an exemption from contradiction detection, it is a decision
wearing a fact's clothes, and it belongs in a table.

The first instance is `contact_dedup_exclusions` (migration 084):

```sql
CREATE TABLE contact_dedup_exclusions (
  contact_a_id UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  contact_b_id UUID        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by   TEXT        NOT NULL,
  PRIMARY KEY (contact_a_id, contact_b_id),
  CONSTRAINT contact_dedup_exclusions_ordered_pair CHECK (contact_a_id < contact_b_id)
);
```

- **One row per unordered pair.** The `CHECK` plus `normalizeExclusionPair()` in
  `src/contacts/dedup-exclusions.ts` mean "is this pair excluded?" is a single indexed
  lookup, not an OR of two orderings, and a pair cannot be recorded twice in mirror image.
- **No node prerequisite.** Contacts with `kg_node_id = NULL` are first-class here.
- **No embeddings, no decay, no confidence.** `decided_at` / `decided_by` are provenance.
- **FK integrity, and we spend it.** Deleting a contact cascades its exclusions away.
  Merging re-points them: `ContactService.mergeContacts` calls
  `backend.reattachDedupExclusions(secondaryId, primaryId)`, which renormalizes each pair
  into stored order, drops the row between the two contacts being merged (merging *is* the
  decision that they are the same person, superseding the earlier ruling), and drops rows
  that would duplicate one the survivor already holds.
- **Narrow on purpose.** No `decision` column, no generalized "dedup decisions" table.
  This table records exclusions. Merge outcomes are already recorded as `contact.merged`
  events in the audit log; modelling them here would give two answers to one question.
- **Single cutover, no dual write.** Migration 084 backfills existing `dedup_exclusion`
  facts into rows, and from the first deploy new exclusions go only to the table. A
  deprecated dual-write path invites drift between two stores of the same ruling, and the
  data volume (~63 facts KG-wide) does not justify the risk. The legacy fact nodes are left
  in place rather than deleted — they cost little and preserve the pre-migration audit
  trail.

`StoreFactOptions.multiValued` from #1624 **stays**. It is a legitimate general memory
primitive for genuinely multi-valued attributes (a person has several email addresses).
Exclusions simply stop being one of its users.

### Rejected alternatives

- **Disambiguated KG labels** (e.g. embedding a discriminator in the label so the two
  exclusion facts are not cosine-identical). Fights the embedding rather than the model
  mismatch, leaves the node prerequisite untouched, and makes labels unreadable.
- **A `not_same_as` KG edge.** This is the honest way to model a pair relation *in* a
  graph, and if the KG were the right store it would be the right shape. It still requires
  a node on both sides — and the null-node population is precisely who this change serves.
- **Force-write / confidence tiebreakers** (write the fact with a flag that bypasses the
  validator, or a confidence high enough to win contradiction resolution). Suppresses the
  symptom per-call, leaves the next KG mechanism to trip over, and still needs a node.
- **A `uuid[]` column on `contacts`.** No FK integrity on array elements, so a merged-away
  contact leaves dangling ids; and the relation has to be maintained on both rows in step,
  which is the bidirectional-consistency problem the ordered-pair table removes.
- **Config-store kv.** No foreign keys, no cascade, and concurrent writers racing on a
  read-modify-write of a JSON blob. `ConfigStore.set` also soft-rejects on conflict rather
  than throwing, so a lost exclusion would be silent.

## Consequences

**Easier.** Excluding a pair now works for any two contacts, which is what #1623 needed.
The check is one indexed lookup, and sweeps load every exclusion in a single query instead
of walking KG edges per pair — `contact-find-duplicates` and `scripts/dedup-contacts.ts`
both drop their `entityMemory` dependency entirely. The exclusion set is directly
inspectable and correctable in SQL, which matters for an operational ledger. Contact
delete and merge now have defined, tested behaviour for exclusions instead of leaving
facts pointing at deleted contact ids.

**Sharp edge this introduces.** A merge now rewrites exclusion rows, so any caller holding
a cached view of the exclusion set must reconcile after merging or it will act on a stale
snapshot — `scripts/dedup-contacts.ts` loads the set once and patches it after each merge
for exactly this reason. CEO rulings also move inside `mergeContacts`' write sequence,
which was a non-transactional run of pool queries when this ADR was written; #1695 closed
that by running the whole sequence in one transaction, so a failed merge no longer leaves
rulings re-pointed onto a survivor that was never written.

**Harder / accepted trade-offs.** Exclusions no longer surface in entity-context assembly
or KG queries — an agent asking "what do we know about this contact" will not see them.
That is the correct boundary (they are not knowledge about the contact), but any future
consumer that wants them must read the table. The one-way cutover means a rollback past
migration 084 loses exclusions recorded after it shipped; the rollback comment in the
migration says so. And the pattern only pays off if it is applied consistently — the point
of writing the rule down is that the next "does this get a table?" question is answered by
the rule rather than case-by-case.

**Explicitly not fixed: KG same-name node identity.** KG node identity is keyed on
`(lower(label), type)`, so two distinct people who share a display name still cannot both
hold KG nodes; the second contact keeps `kg_node_id = NULL`. This ADR removes the
*exclusions*' dependency on that, and nothing else. Same-name contacts remain second-class
KG citizens for facts, relationships, and entity-context enrichment: facts about them have
nowhere to live, and enrichment returns nothing. That is a separate, still-open problem,
tracked in **#1694**. It must not be treated as resolved by this change. The chosen
resolution is ADR-040 (contact-anchored node identity), which supersedes this paragraph.
Implementation is staged across #1694; until the identity model lands, nodeless contacts
are at least *visible* rather than silently context-free.

## Related

- #1625 (this change), #1623 (the incident), PR #1624 (interim `multiValued` fix)
- #1027 / PR #1040 (original decline → exclusion wiring)
- #1694 (KG same-name node identity — still open) / ADR-040 (the chosen resolution)
- #1695 (`mergeContacts` write sequence made transactional — closed)
- ADR-028 (shared, unbound agent memory) for the surrounding memory-governance model

# ADR-040: Contact-anchored KG node identity — a contact's node is identified by the contact, not by its label

Date: 2026-09-01
Status: Accepted

## Context

KG entity identity is keyed on the display name. `idx_kg_nodes_unique` enforces
`(lower(label), type)` uniqueness for every non-fact, non-archived node, and
`idx_contacts_kg_node_unique` allows at most one contact per node. Together they mean
that when a second contact resolves to a node another contact already holds,
`createContact` catches the `23505` and retries without the link — the contact is stored
with `kg_node_id = NULL` by design (`src/contacts/contact-service.ts`).

A contact with `kg_node_id = NULL` cannot hold anything. `entityMemory.storeFact` needs
an `entityNodeId`, so facts about them have nowhere to live. Entity-to-entity edges need
nodes on both sides. `EntityContextAssembler` resolves email → `contacts.kg_node_id` →
node, so enrichment returns nothing and the agent works the conversation with no
background at all. None of it errors. There is no signal distinguishing "we know nothing
about this person" from "this person cannot hold knowledge."

ADR-039 removed *dedup exclusions*' dependency on this by giving them their own table, and
named the remaining gap as out of scope. This ADR closes it.

### Two populations, not one

The obvious population is same-name people: two distinct contacts both called
"Seth Berman", the second one nodeless. That is the case #1623 surfaced.

There is a second, structurally different population. `resolveOrCreateOrgNode` returns the
*same* organization node for every role address at a domain: `info@acme.com` mints the
Acme node, `support@acme.com` resolves to it, collides on `idx_contacts_kg_node_unique`,
and is stored nodeless. Here the 1:1 invariant is simply wrong — several role-address
contacts legitimately represent one organization, and forcing them to compete for a single
link is a modelling error rather than an identity ambiguity. A fix that only re-keys person
identity leaves this half of the nodeless population untouched.

**Measured after acceptance (2026-09-02, production):** the org population is *empirically
zero*. Of 548 contacts, 14 hold no node; none of them are `kind='organization'` (all 38 org
contacts are linked). The collision path above is real and reachable in code, but it has not
yet occurred in this deployment. The org half of this section describes a latent defect, not
an observed one — the relaxed `idx_contacts_kg_node_unique` is worth keeping as prevention,
but it should not be sequenced as though it were clearing a backlog. See Consequences.

### Why label-keyed identity exists at all

The unique index is not the disease; it is the coping mechanism. `upsertNode`'s
`ON CONFLICT (lower(label), type)` is what makes name-based resolution *deterministic*.
`extract-facts` and `memory-store` hand the KG a bare string produced by an LLM and it has
to land somewhere. Remove label uniqueness globally and the graph fragments: three "Acme
Corp" nodes, each holding a third of what Curia knows.

So the question is not how to relax the index. It is **which nodes have an identity anchor
stronger than their name.** Contacts do — channel identities are hard external keys, and
`contacts.id` is stable across renames. A person merely mentioned in an email body does
not; the name is all there is.

### The latent misattribution bug

`EntityMemory.resolveOrCreate` currently handles 2+ exact matches by returning
`matches.find(n => n.type === options.type)` as `found`. The moment N nodes may share a
label, every `memory-store` write for "Seth Berman" silently lands on whichever node sorts
first — strictly worse than the present silent no-op, and so a prerequisite for the
migration rather than a follow-up.

It is also not purely latent today, contrary to an earlier draft of this ADR.
`findNodesByLabel` matches `lower(label)` **or** `aliases`, and aliases carry no cross-node
uniqueness — no unique index on the column, and `addAlias` only checks that the alias is
absent from the node it is writing to. Two person nodes can therefore both carry the alias
"Seth" and the same silent first-match pick applies. `resolveOrCreate`'s own fuzzy path
calls `addAlias` automatically, so such a collision can arise without anyone doing anything
unusual. Rare, but live.

## Decision

**A KG node that backs a contact is identified by that contact. Its label is a display
attribute and carries no identity. Nodes that back no contact keep `(lower(label), type)`
identity exactly as today.**

Identity becomes two-tier, and the tier is recorded on the node so Postgres can enforce it.

### Schema

```sql
ALTER TABLE kg_nodes
  ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'label'
  CHECK (identity_source IN ('label', 'contact'));

DROP INDEX idx_kg_nodes_unique;
CREATE UNIQUE INDEX idx_kg_nodes_unique
  ON kg_nodes (lower(label), type)
  WHERE type != 'fact' AND archived_at IS NULL AND identity_source = 'label';

-- Organization nodes are legitimately shared by several contacts.
DROP INDEX idx_contacts_kg_node_unique;
CREATE UNIQUE INDEX idx_contacts_kg_node_unique
  ON contacts (kg_node_id)
  WHERE kg_node_id IS NOT NULL AND kind <> 'organization';
```

`contacts.kg_node_id` remains the only pointer between the two tables. It has to: the
organization case is genuinely N:1, and a `contact_id` column on `kg_nodes` cannot express
that. Mirroring the pointer on both sides would recreate the bidirectional-consistency
problem ADR-039 rejected for a `uuid[]` column, for no gain — `identity_source` is all the
index needs.

The org relaxation leans on `contacts.kind`, which migration 056 already keeps in sync with
the linked node's type.

### Invariants

1. **`upsertNode` is the label-keyed path, exclusively.** It only ever inserts
   `identity_source = 'label'` rows, and its `ON CONFLICT` predicate matches the index
   above. Anchored nodes are minted through `createNode`. This is what stops the two tiers
   from leaking into each other: no caller can accidentally upsert its way onto somebody's
   anchored node.
2. **One anchored node per contact, at most one contact per non-organization node.**
   Enforced by `idx_contacts_kg_node_unique` as relaxed above.
3. **An anchored node's label is free to collide.** Two nodes labelled "Seth Berman", both
   `identity_source = 'contact'`, are correct and expected.

### Adoption, not blind creation

`createContact`'s person path resolves a label match **filtered to unanchored nodes**:

> **Adopt an unanchored node whose label matches; otherwise mint a new anchored one. Never
> take a node that already belongs to another contact.**

Adoption promotes the node to `identity_source = 'contact'` and links it, which preserves
the genuinely good part of today's behaviour: Curia learns about "Dana Wu" from an email
body, Dana later emails in, and the new contact inherits the facts already accumulated
about her rather than starting empty.

Two contacts can race to adopt the same unanchored node. `idx_contacts_kg_node_unique`
still catches it; the retry **mints a fresh anchored node** instead of dropping the link.
That is the direct repair of the behaviour this ADR exists to remove — a collision must
never again produce a nodeless contact.

### Resolution under ambiguity

`resolveOrCreate` stops guessing:

- 2+ exact matches sharing the requested type → `ambiguous`, not `found`-first-match.
- `findNodesByLabel` continues to return anchored nodes. Ambiguity becoming *visible* is
  the point; hiding anchored nodes from label lookup would let Phase 3 mint a third
  "Seth Berman" on every write.

`memory-store` already surfaces `ambiguous` candidates to the agent and already accepts a
UUID entity, so the coordinator can disambiguate and the `alias_for` path records the
answer. No change needed there.

`extract-facts` is the one caller that cannot disambiguate: it receives only `text` and
`source`, and today takes `candidates[0]`. Under this ADR that is active misattribution.
It gains an **optional subject-contact input** so callers that do know the subject (the
observe pipeline knows the sender) can pass it; when no context resolves the ambiguity the
fact is **skipped and counted**, never guessed. Losing a fact is recoverable; writing it
onto the wrong person is not.

### Contact deletion

Deleting a contact **archives its anchored node** (`archived_at = now()`), which is only
unambiguous because nothing else archives anchored nodes — see *Identity does not decay*
below. Archiving is the right instrument here for three reasons: `idx_kg_nodes_unique` already excludes archived
rows, so the label is freed for reuse without a demote step that could itself raise a
unique violation *during a delete*; the node and its facts are soft-deleted, so the
knowledge is recoverable in SQL rather than destroyed; and it reuses the dream engine's
existing archival semantics instead of inventing an orphan state nothing else understands.

Organization nodes are exempt — they are unanchored and shared, and outlive any one
contact.

### Identity does not decay

Archiving an anchored node on contact deletion gives `archived_at` a specific meaning for
these rows: *this contact is gone*. That meaning only holds if nothing else archives them.
Today something does.

`DreamEngine` decays every non-permanent node continuously and archives anything at or
below `archiveThreshold` (0.05), with no exclusion for nodes a contact points at. Its
decay-warning mechanism does not help: a node is "important" enough to warn only if it
carries high sensitivity or has an edge count at or above the p95 floor of 5, and being a
contact's node is not a criterion. Warned nodes are archived anyway after
`warnHoldBackDays`. Measured in production: **532 of 534** contact-linked nodes are
non-permanent, and **478** of those would be archived with no warning at all.

Nor does interaction protect them. The only writes that refresh an entity node's
`last_confirmed_at` are an explicit `updateNode`, a human confirming a decay warning, and a
creation-time upsert collision. Receiving mail from someone, replying to them, and storing
facts *about* them all leave the entity node untouched — `storeFact`'s `updateNode` calls
target the fact node, not the entity. A contact you email daily decays at exactly the same
rate as one you met once. The decay is monotonic and universal.

So: **a contact's node is the container for its memory, not a memory itself. Containers
persist as long as the contact does; contents age normally.**

Contact-anchored nodes are excluded from decay and from archival — the predicate
`identity_source = 'label'` is added to `DreamEngine`'s decay passes (1a, 1b) and its
node-archival pass (2b). Facts hanging off an anchored node keep decaying exactly as
before, so this does not freeze memory; it stops the *anchor* from evaporating out from
under a live contact.

This is ADR-039's rule applied consistently rather than a new one. *Did a process decide
this, or did Curia learn it?* A contact-anchored node's existence is decided by contact
creation. Its facts are learned. The first gets a durable row; the second decays.

Rejected: promoting anchored nodes to `decay_class = 'permanent'` in the backfill. It
needs no `DreamEngine` change and reuses migration 062's mechanism, but it is a data fix
rather than a rule — `createContact` and every future node-writing path has to remember to
set it, and any `updateNode` can silently clear it. That is an invariant maintained by
convention across N call sites, which is the same shape this ADR rejected for the identity
pointer. It also overloads `permanent`, which today means "a fact that will never change".

### Backfill

Migration `085` repairs the existing nodeless population in two arms and **never merges two
contacts into one node**:

1. **Organization arm.** A nodeless contact with `kind = 'organization'` and a
   `primary_email` whose domain matches an existing org node's `properties->>'domain'` is
   linked to that node. This is now legal under the relaxed contact index and reconstructs
   exactly the link the original collision denied.
2. **Person arm.** Every other nodeless contact gets a freshly minted anchored node at
   `confidence 0.5`, `source = 'migration_085'`, mirroring migration 056's convention.

Existing linked nodes are flipped to `identity_source = 'contact'` in the same migration.
Everything else keeps the default `'label'`.

The backfill deliberately makes no attempt to detect that two nodeless "Seth Berman"
contacts might be one person. That is the dedup sweep's job.

An earlier draft of this ADR claimed the backfill also makes contact merges carry KG memory,
because `mergeContacts` only calls `mergeEntities` when *both* sides have a node. The
precondition is right and the conclusion is wrong. `mergeEntities` hard-`DELETE`s the
secondary node while the secondary contact still points at it, and `contacts.kg_node_id`
is a `NO ACTION` foreign key, so the delete raises `23503` and the merge is swallowed as
"KG node merge failed (non-fatal)". This is pre-existing and already near-universal —
534 of 548 contacts were linked before `085` — so the backfill neither causes it nor cures
it. Tracked separately in #1711; until that lands, a contact merge still loses KG memory.

### Rejected alternatives

- **A discriminator column in the uniqueness key** (`UNIQUE (lower(label), type,
  discriminator)`, `''` for existing rows). Smaller migration, no exemption predicate, no
  orphan state. Rejected because it relaxes the constraint without supplying an identity
  model: it permits N nodes per label without saying what distinguishes them or which one a
  name-only write should resolve to. If the discriminator is the contact id it is this ADR
  with a mirrored pointer that can drift; if it is opaque, nothing enforces the
  contact↔node invariant and `resolveOrCreate` is left guessing with no principled basis.
- **Moving the pointer to `kg_nodes.contact_id` and dropping `contacts.kg_node_id`.**
  Attractive in pure schema terms — one column enforces both rules. Rejected because it
  cannot express the organization N:1 case at all, and because `contacts.kg_node_id` is
  read on the entity-context hot path and by contact-service, agent bootstrap, export
  controls, and the console routes; replacing it with a join is a large refactor that buys
  nothing this ADR needs.
- **Dropping label uniqueness for every node type.** Fragments organizations, projects, and
  concepts, where the label *is* the only available identity and `upsertNode`'s dedup is
  load-bearing.
- **Visibility only** — instrument the nodeless population and defer the model. Kept, but as
  the first increment rather than the resolution: it is what tells us the true size and
  person/org split of the population before the migration runs. It fixes nothing on its own.
- **Auto-merging same-name nodeless contacts during the backfill.** Would collapse two real
  people into one node with no human ruling, which is precisely the failure #1623 was
  about.

## Consequences

**Easier.** Two people who share a name each hold their own node, facts, relationships, and
entity-context enrichment. Role-address contacts stop competing for their organization's
node. Contact merges finally carry KG memory, because both sides now have something to
merge. The identity rule is enforced by Postgres rather than maintained by convention, and
`identity_source` makes "why does this node not dedup by label?" answerable from a single
column.

**Accepted: the graph stops self-pruning contact anchors.** Excluding anchored nodes from
decay means the node count for contacts only grows, and a contact who is never heard from
again keeps their anchor indefinitely. That is deliberate — the alternative is an identity
that evaporates on a timer — but it moves the cleanup question onto contact deletion, which
is now the only thing that retires an anchor. Facts still decay, so the storage that
actually accumulates is still bounded by the existing mechanism.

**Harder / accepted trade-offs.** There are now two identity tiers to keep in mind, and the
`upsertNode`-is-label-only invariant is the seam where a careless caller could put an
anchored node back into the label pool. Name-only writes return `ambiguous` far more often
than before — that is correct, but it moves work onto the coordinator, and `extract-facts`
will silently skip facts about common names until callers pass subject context. Deleting a
contact now archives real knowledge along with it; recoverable, but a behaviour change from
today's leave-it-orphaned.

**Migration risk, now measured.** The visibility increment (#1701) landed first specifically
so `085` could be written against a known number rather than an assumed one. Run against
production on 2026-09-02 via `scripts/kg-node-linkage-report.ts`:

| | |
|---|---|
| contacts total | 548 |
| holding no KG node | 14 (2.6%) |
| arm A — org re-link | **0** |
| arm B — mint a node | **14** |
| shadowed by a same-name contact that has a node | 12 |

By kind, the nodeless 14 are 12 `person` and 2 `automated`; `organization`, `principal` and
`agent` are fully linked. Across the whole table there are 14 same-name clusters and the
largest holds 3 contacts.

So the migration inserts 14 rows, and 12 of the 14 are the same-name case #1623 described.
This is a much smaller and better-bounded change than this ADR assumed when it was accepted,
and it moves the risk out of the migration. Two consequences for sequencing: the org index
relaxation is prevention rather than repair and should not lead, and the `resolveOrCreate`
ambiguity fix — which addresses a live alias-collision path, per Context — should.

**Name-only extraction gets quieter, not smarter.** Two contacts sharing a display name now
produce two same-label person nodes, and `findNodesByLabel` returns both by design. So every
name-only write about that name resolves `ambiguous`: `extract-facts` skips and counts it
unless `subject_contact_id` picks a side, and the only caller supplying that hint is the
checkpoint processor, which passes the conversation's counterpart — so a fact about a *third
party* named in a transcript is dropped rather than stored. The nodes exist and can hold
facts; the automatic extraction path largely cannot write to them without a hint. Watch the
`ambiguous` counter after deploy. `extract-relationships` is worse and is tracked in #1714:
it still takes `candidates[0]`, so it misattributes rather than skipping.

**Orphaned anchors accumulate.** An anchored node whose contact goes away without archival
never decays, because every decay and archival path now excludes the anchored tier. Three
paths produce them: an adoption abandoned when the contact INSERT fails, orphan cleanup after
a lost `linkIdentity` race (which must not archive, since the node may predate the attempt),
and a contact merge whose KG half fails on the foreign key (#1711). The first two are logged
at `warn`; the third is repaired inline. `scripts/kg-node-linkage-report.ts` counts them, and
a growing number is the signal that name-only extraction is silently degrading, since two
same-label nodes make every write about that name ambiguous.

**Not addressed.** Nothing here improves resolution *quality* for names Curia has never
associated with a contact — an unanchored "Seth Berman" mentioned in an email body still
resolves by label and embedding, with all the fuzziness that implies. This ADR gives
contacts a durable identity; it does not give the KG one for everyone else.

## Related

- #1694 (this change), #1623 (the incident), #1625 / ADR-039 (named this as the remaining gap)
- PR #1624 (design review that rejected `ensureKgNode` as the fix)
- PR #1700 (this ADR), PR #1701 (increment 1 — visibility, and the measurement above)
- #1702 (`entity-context` reports a DB failure as "contact not found" — the same
  absence-of-evidence failure on the error path, found while reviewing #1701)
- #1707 (the entity-context read path ignores `archived_at`, so archived nodes and facts
  still assemble — adjacent, and made load-bearing by the deletion rule above)
- #1711 (contact merge loses KG memory on a foreign-key violation — pre-existing, and the
  reason the Backfill section above no longer claims `085` fixes merges)
- #1714 (`extract-relationships` still picks `candidates[0]` — pre-existing, but this ADR
  makes same-label collisions routine rather than rare)
- Migrations 010, 016, 027, 056 (the indexes and backfills this supersedes or amends)
- ADR-028 (shared, unbound agent memory) for the surrounding memory-governance model

# ADR-040: Contact-anchored KG node identity — a contact's node is identified by the contact, not by its label

Date: 2026-09-01
Status: Proposed

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
`matches.find(n => n.type === options.type)` as `found`. Today the unique index makes two
same-type matches impossible, so the branch is unreachable for the case that matters. The
moment N nodes may share a label, every `memory-store` write for "Seth Berman" silently
lands on whichever node sorts first. That is strictly worse than the present silent no-op,
and fixing it is a prerequisite for the migration rather than a follow-up.

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

Deleting a contact **archives its anchored node** (`archived_at = now()`). Archiving is the
right instrument here for three reasons: `idx_kg_nodes_unique` already excludes archived
rows, so the label is freed for reuse without a demote step that could itself raise a
unique violation *during a delete*; the node and its facts are soft-deleted, so the
knowledge is recoverable in SQL rather than destroyed; and it reuses the dream engine's
existing archival semantics instead of inventing an orphan state nothing else understands.

Organization nodes are exempt — they are unanchored and shared, and outlive any one
contact.

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
contacts might be one person. That is the dedup sweep's job, and it now works better:
`mergeContacts` only calls `mergeEntities` when *both* sides have a node
(`src/contacts/contact-service.ts`), so giving every contact a node is what finally lets a
contact merge carry memory across.

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

**Harder / accepted trade-offs.** There are now two identity tiers to keep in mind, and the
`upsertNode`-is-label-only invariant is the seam where a careless caller could put an
anchored node back into the label pool. Name-only writes return `ambiguous` far more often
than before — that is correct, but it moves work onto the coordinator, and `extract-facts`
will silently skip facts about common names until callers pass subject context. Deleting a
contact now archives real knowledge along with it; recoverable, but a behaviour change from
today's leave-it-orphaned.

**Risk concentrated in the migration.** `085` mints a node per nodeless contact, and the
true size of that population is not yet measured in production. The visibility increment
lands first specifically so the migration is written against a known number rather than an
assumed one.

**Not addressed.** Nothing here improves resolution *quality* for names Curia has never
associated with a contact — an unanchored "Seth Berman" mentioned in an email body still
resolves by label and embedding, with all the fuzziness that implies. This ADR gives
contacts a durable identity; it does not give the KG one for everyone else.

## Related

- #1694 (this change), #1623 (the incident), #1625 / ADR-039 (named this as the remaining gap)
- PR #1624 (design review that rejected `ensureKgNode` as the fix)
- Migrations 010, 016, 027, 056 (the indexes and backfills this supersedes or amends)
- ADR-028 (shared, unbound agent memory) for the surrounding memory-governance model

# Contact Specialist Agent — Design

**Date:** 2026-05-11
**Issue:** josephfung/curia#498
**Status:** Draft

## Overview

`coordinator.yaml` has accumulated ~165 lines of contact-domain prompt guidance across five
sections plus 14 contact-related pinned skills. This isn't routing logic — it's a domain that
deserves its own context, scratchpad, and ownership. This spec defines the Contact Specialist
agent (`agents/contacts.yaml`) that takes full ownership of the contact domain, and the
corresponding coordinator cleanup.

The entity-context enrichment system (spec 11, Phase 1 complete) already makes entity
resolution invisible to the LLM at the skill level via `entity_enrichment` manifest
declarations. This spec is the complementary move at the coordinator level: replacing
explicit `contact-lookup` calls with a richer delegation interface.

---

## Design

### Approach

Full domain migration (Approach 1). All 14 contact-related skills plus `entity-context`,
`query-relationships`, and `delete-relationship` move from `coordinator.yaml` to the new
`contacts.yaml`. The coordinator retains zero contact skills; all contact intelligence flows
through `delegate` → contacts specialist.

The alternative of keeping `contact-lookup` as a coordinator-level primitive (Approach 2) was
considered but rejected. The stated end-state (spec 11 + this spec) is zero explicit
`contact-lookup` calls on the coordinator. If Approach 1 causes latency problems in practice,
`contact-lookup` can be re-added as a primitive without redesign.

---

## `agents/contacts.yaml`

### Agent Metadata

```yaml
name: contacts
role: specialist
description: >
  Contact domain specialist — briefings, CRUD, deduplication, relationship management,
  and memory entity resolution for people and organizations
model:
  provider: anthropic
  model: claude-sonnet-4-6
allow_discovery: false
```

No `memory:` scopes restriction. Contact data lives in the global KG partition (same as
coordinator). A scoped partition (e.g. `contacts`) is not warranted here — the specialist
needs to read and write the same facts the coordinator and other specialists use.

### Pinned Skills (18)

| Group | Skills |
|---|---|
| Identity & CRUD | `contact-create`, `contact-lookup`, `contact-link-identity`, `contact-unlink-identity`, `contact-set-role`, `contact-set-trust`, `contact-rename`, `contact-list` |
| Lifecycle | `contact-merge`, `contact-find-duplicates`, `contact-grant-permission`, `contact-revoke-permission` |
| Knowledge graph | `query-relationships`, `delete-relationship` |
| Context enrichment | `entity-context` |
| Memory | `memory-query`, `memory-store` |
| Calendar (read-only) | `calendar-list-events` |

`calendar-list-events` is included solely for enrichment — pulling recent meeting history as
part of briefings. It is a read-only skill; the specialist never creates or modifies calendar
events.

> **@TODO:** When a calendar specialist is carved out (same pattern as this issue), revisit
> whether `calendar-list-events` should move there and the contacts specialist should receive
> meeting history via delegation instead.

### System Prompt Structure

Seven sections, in order:

1. **Role** — Brief framing: the specialist owns the full contact domain; the coordinator
   delegates contact intelligence here; the specialist never communicates directly with
   external parties; all responses go back to the coordinator for synthesis.

2. **Briefing pattern** — The primary interface. The coordinator sends natural-language briefs:
   _"Brief me on Sarah Johnson — I'm about to schedule a meeting with her."_ The specialist
   resolves the name, assembles entity context (contact record + stored facts + relationships +
   connected accounts + recent meeting history via `calendar-list-events`), and returns a
   natural-language briefing followed by a machine-readable `<resolved_entities>` block (see
   Briefing Protocol below). If a name is ambiguous, the specialist returns the candidates
   and withholds the `<resolved_entities>` block until the coordinator disambiguates.

3. **Contact CRUD** — Migrated from coordinator's "Contact Awareness" section (~50 lines).
   When to create, link, set-role, and enrich contacts; how to handle new email arrivals;
   what to do when contact details conflict.

4. **Contact Lookup Best Practices** — Migrated verbatim from coordinator (~20 lines). The
   "never claim you don't know someone without running `contact-lookup`" rule; partial name
   matching; provisional contact handling.

5. **Contact Deduplication** — Migrated verbatim from coordinator (~45 lines). The
   `contact.duplicate_detected` notification workflow; the weekly scan workflow; the primary
   heuristic table (verified identities → role → created_at → ask CEO). The autonomy `@TODO`
   for auto-merging `certain` pairs migrates with it.

6. **Relationship Management** — Migrated verbatim from coordinator (~10 lines). When to use
   `query-relationships` vs `delete-relationship`; confirmation language after deletion.

7. **Memory — entity resolution** — Subset only (~20 lines). The entity resolution quick
   reference table (named contact → `contact-lookup` → `kg_node_id`; named person not in
   contacts → `contact-create`; non-person entity → pass name directly to `memory-store`) plus
   decay class guidance (`permanent` / `slow_decay` / `fast_decay`). The general proactive-recall
   guidance, config namespace guidance, and storing/outcome-handling guidance stay exclusively
   on the coordinator — those are general CEO-facing capabilities, not contact domain specifics.

### Schedule

```yaml
schedule:
  - cron: "0 9 * * 1"   # Mondays at 9 AM
    task: >
      Run your weekly contacts dedup scan — find probable and certain duplicate contact pairs,
      present them to the CEO for review one pair at a time, and merge confirmed pairs.
    expectedDurationSeconds: 300
```

Intent-anchor is written to describe what should be achieved, not which tools to call (per
coordinator's scheduling guidance).

---

## `coordinator.yaml` Changes

### Skills Removed (15)

```
contact-create        contact-lookup         contact-link-identity
contact-unlink-identity  contact-set-role    contact-set-trust
contact-rename        contact-list           contact-merge
contact-find-duplicates  contact-grant-permission  contact-revoke-permission
query-relationships   delete-relationship    entity-context
```

`memory-query` and `memory-store` remain on the coordinator — they serve general CEO-facing
use cases (travel preferences, non-contact entities, standing instructions) that must not be
routed exclusively through the contacts specialist.

### Prompt Sections Removed (~165 lines)

- Contact Awareness
- Contact Lookup Best Practices
- Contact Deduplication (including primary heuristic table and `@TODO`)
- Relationship Management
- Memory — entity resolution quick reference table and decay-class guidance

### Prompt Sections Updated

**"Your Identity" block** — the instruction _"For everyone else… ALWAYS use contact-lookup
first to resolve their name to a real contact ID"_ is replaced with:

> For everyone else, delegate to the contacts specialist using the "brief me" pattern.
> The specialist returns enriched context including the contact ID in a
> `<resolved_entities>` block. Use those IDs directly in downstream skill calls —
> do not attempt to re-resolve names already in the block.

**Email pre-compose instruction** — _"resolve ALL recipients and CC contacts using
contact-lookup"_ is replaced with a brief note to delegate recipient resolution to the
contacts specialist.

**`contact.duplicate_detected` handling** — the coordinator's inline dedup workflow is
replaced with a delegation note: when this notification arrives, delegate the dedup workflow
to the contacts specialist at the next natural opportunity.

### Delegation Note Added (~8 lines)

```
## Contact Intelligence
Contact intelligence — briefings, CRUD, deduplication, relationship lookups,
and entity resolution for people and organizations — belongs to the contacts
specialist. Delegate using the "brief me" pattern:
  "Brief me on Sarah Johnson — I'm about to schedule a meeting with her."
When you receive a contact.duplicate_detected notification, delegate the dedup
workflow to the contacts specialist at the next natural opportunity.
```

### Net Reduction

Removing ~165 lines, adding ~8 lines → **≥150 line net reduction**. Meets acceptance criterion.

---

## Briefing Protocol

### Request (Coordinator → Specialist)

Natural-language task via `delegate`. No structured input schema required.

Single contact:
> "Brief me on Sarah Johnson — I'm about to schedule a meeting with her."

Multiple contacts:
> "Brief me on everyone attending Thursday's board call: Sarah Johnson, Greg Kim, Nik Patel."

The coordinator may include task context that helps the specialist tune the briefing (e.g.,
"about to schedule a meeting", "composing a follow-up email", "reviewing a term sheet with").

### Response (Specialist → Coordinator)

Natural-language briefing (or CRUD confirmation) the coordinator can synthesize directly,
followed by a machine-readable block. The `<resolved_entities>` block is included in **any**
specialist response where a contact was resolved or created — not only briefings. This gives
the coordinator a consistent hook for downstream skill calls regardless of the operation type.

```
Sarah Johnson is the CFO at Acme Corp. She prefers concise, data-driven communication
and morning meetings (before noon). Her Zoom link is on file. Last met 2026-04-28 re:
Series B term sheet review. No open relationship conflicts.

<resolved_entities>
  <contact name="Sarah Johnson" id="abc-123" role="CFO" org="Acme Corp"/>
</resolved_entities>
```

For multi-contact briefs, multiple `<contact>` elements appear in the same block:

```xml
<resolved_entities>
  <contact name="Sarah Johnson" id="abc-123" role="CFO" org="Acme Corp"/>
  <contact name="Greg Kim" id="def-456" role="CTO" org="Acme Corp"/>
  <contact name="Nik Patel" id="ghi-789" role="Investor" org="Sequoia"/>
</resolved_entities>
```

### Ambiguity Handling

If a name is ambiguous (two Michaels), the specialist returns the candidates in plain text
and withholds the `<resolved_entities>` block entirely. The coordinator surfaces the
ambiguity to the CEO, then re-delegates with the clarified name once resolved.

### What the Specialist Assembles Per Contact

Via `entity-context` + `memory-query` + `calendar-list-events`:

| Source | Data |
|---|---|
| Contact record | Name, role, org, verified channel identities |
| Memory facts | Preferences, notes, relationship context |
| Connected accounts | Calendars, email (relevant to stated task) |
| Relationships | First-degree relationships relevant to task |
| Calendar history | Recent meetings (via `calendar-list-events`) |

The specialist exercises judgment about depth — a "scheduling a meeting" brief surfaces
calendar and timezone preferences; a "reviewing a term sheet" brief surfaces relationship
history and communication preferences.

---

## Weekly Dedup Scan Migration

### At Deploy Time

If a coordinator-level dedup scheduler record exists, it must be cancelled before the new
contacts specialist goes live. The implementation plan includes a step to query
`scheduler-list` for dedup tasks targeting the coordinator and cancel them via
`scheduler-cancel` if present. A fresh install with no existing record can skip this step.

### Runtime

The `schedule:` entry in `contacts.yaml` creates the new scheduled task targeting the
contacts specialist on first boot. The dedup workflow (find pairs → heuristic → dry_run
preview → CEO confirmation → merge) executes on the specialist, which owns all required
skills.

---

## Smoke Tests

### Existing Cases (No Changes Required)

The following cases test coordinator behaviour as seen by the CEO. That behaviour does not
change — only the internal pathway does. These cases pass before and after, and now
implicitly exercise the delegation chain:

| Case | What it exercises |
|---|---|
| `ambiguous-contact.yaml` | Coordinator surfaces name ambiguity to CEO |
| `conflicting-contact.yaml` | Coordinator handles conflicting contact info |
| `register-after-link.yaml` | Contact creation + identity linking flow |
| `role-person-mismatch.yaml` | Role vs person conflict detection |

### New Case

**`tests/smoke/cases/briefing-contact.yaml`** — tests the "brief me" delegation pattern
end-to-end:

- CEO asks coordinator to schedule a meeting with a named contact
- Coordinator delegates a briefing to the contacts specialist
- Specialist returns enriched context + `<resolved_entities>` block
- Coordinator uses the returned contact ID to proceed with the task

Expected behaviours:
- Correct contact is identified without a second lookup
- Downstream skill receives the correct contact ID from the briefing
- CEO-facing response does not expose the delegation internals
- If name is ambiguous, coordinator asks for clarification before proceeding

---

## Relationship to Spec 11 (Entity Context Enrichment)

These two are complementary:

| Layer | Mechanism | Status |
|---|---|---|
| Skill level | `entity_enrichment` manifest declaration → `ctx.entityContext` pre-populated | Phase 1 done; Phase 2 (calendar skills) pending |
| Coordinator level | Contact Specialist "brief me" delegation | This spec |

Once both are fully in place, the coordinator has zero explicit `contact-lookup` calls.
Entity enrichment handles resolution within skills; the Contact Specialist handles
coordinator-level contact intelligence.

---

## Acceptance Criteria

- [ ] `agents/contacts.yaml` exists with a focused system prompt covering briefings, CRUD,
      dedup workflow, relationship management, and memory entity resolution
- [ ] All 14 contact skills + `query-relationships`, `delete-relationship`, `entity-context`
      removed from `coordinator.yaml` `pinned_skills`
- [ ] `memory-query` and `memory-store` remain in `coordinator.yaml` `pinned_skills` and are
      also added to the contacts specialist
- [ ] Coordinator's five contact-domain prompt sections removed; replaced with brief
      delegation note
- [ ] Weekly dedup scan migrates from coordinator schedule to contacts specialist schedule;
      existing coordinator scheduler record cancelled at deploy
- [ ] Coordinator delegates "brief me on X" to specialist; specialist response includes
      `<resolved_entities>` XML block with contact IDs for downstream skill calls
- [ ] `briefing-contact.yaml` smoke test added; all existing contact smoke tests pass
- [ ] `coordinator.yaml` system prompt reduced by ≥ 150 lines net

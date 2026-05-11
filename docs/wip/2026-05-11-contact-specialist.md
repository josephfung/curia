# Contact Specialist Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carve the contact domain out of `coordinator.yaml` into a new `agents/contacts.yaml` specialist, replacing explicit skill calls with a "brief me" delegation pattern and XML `<resolved_entities>` response protocol.

**Architecture:** Create `agents/contacts.yaml` with 18 pinned skills and a focused 7-section system prompt. Strip ~165 lines of contact-domain guidance from `coordinator.yaml`, remove 15 contact-related pinned skills, and replace them with an 8-line delegation note. Coordinator delegates all contact intelligence via `delegate` → contacts specialist → XML tags back. No TypeScript changes; all work is YAML.

**Tech Stack:** YAML agent config, smoke test YAML, `pnpm run smoke` test runner.

**Spec:** `docs/wip/2026-05-11-contact-specialist-design.md`

---

## File Map

| Action | File | Purpose |
|---|---|---|
| Create | `agents/contacts.yaml` | New Contact Specialist agent — full contact domain |
| Modify | `agents/coordinator.yaml` | Remove 15 skills + ~165 lines of prompt; add delegation note |
| Create | `tests/smoke/cases/briefing-contact.yaml` | Smoke test for "brief me" delegation pattern |

---

## Task 1: Write the smoke test

**Files:**
- Create: `tests/smoke/cases/briefing-contact.yaml`

- [ ] **Step 1.1: Create the smoke test case**

```yaml
# tests/smoke/cases/briefing-contact.yaml
name: Contact Briefing Delegation
description: >
  Coordinator should delegate contact resolution to the contacts specialist when
  preparing for an interaction, receive a briefing with a <resolved_entities> block,
  and use the returned contact ID for downstream skill calls — without exposing
  delegation internals to the CEO.
tags:
  - contacts
  - delegation
  - single-turn

turns:
  - role: user
    content: |
      Schedule a 30-minute meeting with Sarah Johnson next week.

expected_behaviors:
  - id: delegates-to-contacts
    description: >
      Coordinator delegates to the contacts specialist (via the "brief me" pattern)
      rather than calling contact-lookup directly
    weight: critical
  - id: correct-contact-resolved
    description: >
      The correct contact (Sarah Johnson) is identified and her details are used
      in the scheduling request
    weight: critical
  - id: no-second-lookup
    description: >
      Coordinator does not attempt to re-resolve Sarah's identity after receiving
      the briefing — it uses the ID from the <resolved_entities> block directly
    weight: important
  - id: no-internals-exposed
    description: >
      CEO-facing response does not mention the contacts specialist, delegation,
      contact IDs, or any internal system details
    weight: critical
  - id: scheduling-proceeds
    description: >
      Coordinator proceeds to schedule the meeting (or asks for clarifying details
      like time preference) using the resolved contact
    weight: important

failure_modes:
  - Coordinator calls contact-lookup directly instead of delegating
  - Contact ID is not passed to the calendar or scheduling skill
  - Response mentions "contacts specialist", "delegating", or internal IDs
  - Coordinator asks "Who is Sarah Johnson?" despite contacts being available
```

- [ ] **Step 1.2: Verify the YAML loads without errors**

```bash
npm --prefix /path/to/worktree run smoke -- --case "Contact Briefing"
```

Expected: fails with a meaningful error (contacts specialist not registered yet, or coordinator still calls contact-lookup directly). This confirms the test is wired up and will catch the missing implementation.

Note: substitute the actual worktree path, e.g. `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-contact-specialist`.

- [ ] **Step 1.3: Commit**

```bash
git -C /path/to/worktree add tests/smoke/cases/briefing-contact.yaml
git -C /path/to/worktree commit -m "test: add briefing-contact smoke test for delegation pattern (#498)"
```

---

## Task 2: Create `agents/contacts.yaml`

**Files:**
- Create: `agents/contacts.yaml`

- [ ] **Step 2.1: Create the file**

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
system_prompt: |
  ## Role
  You are the Contact Specialist. You own the full contact domain for the executive
  assistant system. The coordinator delegates all contact intelligence to you —
  briefings, CRUD, deduplication, relationship management, and entity resolution.
  You never communicate directly with external parties. All your responses go back
  to the coordinator for synthesis and delivery.

  ## Briefing Pattern
  Your primary interface is the "brief me" delegation request from the coordinator:
  > "Brief me on Sarah Johnson — I'm about to schedule a meeting with her."

  When you receive a briefing request:
  1. Resolve the name using contact-lookup (partial name matching is supported).
     If the name is ambiguous (multiple results), return the candidates in plain
     text and do NOT include a <resolved_entities> block — withhold it until the
     coordinator disambiguates and re-delegates with the clarified name.
  2. Assemble entity context using entity-context (contact record, connected
     accounts, stored facts, relationships).
  3. Query memory-query for relevant stored context: preferences, relationship
     notes, standing instructions, communication style.
  4. Query calendar-list-events for recent meetings with this contact (last 90
     days). Use their calendar ID from entity-context if available. Include
     meeting titles and dates in the briefing.
  5. Return a natural-language briefing followed by a <resolved_entities> block.

  The <resolved_entities> block MUST be included in any response where a contact
  was resolved or created — not only briefings. This includes CRUD confirmations,
  so the coordinator always has the contact ID available for downstream skill calls.

  ### Briefing response format

  Single contact:
  ```
  [Natural-language briefing — facts, preferences, meeting history, relationships
  relevant to the stated task. Write for a coordinator who will synthesize this
  into their own voice.]

  <resolved_entities>
    <contact name="[display name]" id="[contact ID]" role="[role if known]" org="[org if known]"/>
  </resolved_entities>
  ```

  Multiple contacts:
  ```
  [Briefing covering all contacts]

  <resolved_entities>
    <contact name="Sarah Johnson" id="abc-123" role="CFO" org="Acme Corp"/>
    <contact name="Greg Kim" id="def-456" role="CTO" org="Acme Corp"/>
  </resolved_entities>
  ```

  ### Briefing depth
  Tune the depth to the stated task context:
  - Scheduling → calendar preferences, timezone, recent meetings, availability notes
  - Email composition → communication style, role, relationship history
  - Term sheet / negotiation → relationship depth, known preferences, decision authority

  <!-- @TODO: When a calendar specialist is carved out (same pattern as this agent),
       revisit whether calendar-list-events should move there and the contacts specialist
       should receive meeting history via delegation instead.
       See josephfung/curia#498. -->

  ## Contact CRUD
  When the CEO mentions a new person (name, role, email, phone), use contact-create
  to record them. When the CEO provides new contact details for someone who already
  exists, use contact-link-identity or contact-set-role.

  When the CEO mentions someone by name and you need to find their details, use
  contact-lookup. If a name is ambiguous (e.g., "Michael" could be multiple people),
  use contact-lookup to check, then return all candidates — let the coordinator ask
  the CEO to clarify.

  When you notice conflicting information about a contact (e.g., a different email
  or role than what's on file), flag the discrepancy in your response — let the
  coordinator surface it to the CEO before updating.

  When an email arrives from someone not yet in contacts, the system auto-creates
  a contact. Enrich it with contact-set-role if the coordinator provides their role.

  ## Contact Lookup Best Practices
  - **NEVER claim you don't know someone, or comment on their contact record, until
    you have run contact-lookup.** This includes phrases like "I don't think I have
    Nik", "no role on file", or "I don't see them on file." Run the lookup first,
    then respond based on what it returns. Skipping this step and guessing is not
    acceptable.
  - contact-lookup supports partial name matching. "Joe" will find "Joe Brennan".
  - Always search contacts before asking the coordinator to ask the CEO for details.
  - The lookup returns channel identities (email, phone, etc.) alongside the contact.
  - If a contact's status is "provisional", flag this in your response — provisional
    contacts can't take actions until the CEO confirms them.

  ## Contact Deduplication

  ### When you receive a contact.duplicate_detected notification
  A background check found that a newly-created contact may be a duplicate of an
  existing one. Handle this at the next natural opportunity (not as an interrupt):
  1. Use contact-lookup to load both contacts in full (IDs are in the notification).
  2. Identify the primary contact using this heuristic (in priority order):
     - Most verified channel identities
     - Has a role assigned
     - Older created_at (established contact wins)
  3. Call contact-merge with dry_run: true to get the golden record preview.
  4. Present both contacts side-by-side, show what will change, and ask the
     coordinator to confirm with the CEO before merging. Example:
     "I noticed two contacts that look like the same person:
     - Jenna Torres (CFO, verified email jenna@acme.com)
     - J. Torres (no role, email jenna@acme.com)
     I'd merge them into Jenna Torres (CFO). Want me to proceed?"
  5. On confirmation: call contact-merge with dry_run: false.
  6. Never auto-merge without CEO confirmation.

  ### Weekly contacts dedup scan
  When the scheduler sends "Run your weekly contacts dedup scan":
  1. Call contact-find-duplicates (default min_confidence: probable).
  2. If no pairs found: confirm that no duplicates were detected.
  3. If pairs found: work through them one at a time.
     - For each pair: use the primary heuristic above, call contact-merge dry_run: true,
       present the preview, get confirmation, then merge.
     - If the CEO defers a pair ("skip this one"), move on without merging.
     - Continue until all pairs are reviewed or the CEO ends the session.
  4. After finishing: summarize what was merged.

  ### Primary contact heuristic (for merge decisions)
  Apply in order — first rule that produces a clear winner decides:
  1. More verified channel identities → that contact is primary
  2. Has role assigned, other does not → the one with a role is primary
  3. Older created_at → the older contact is primary
  4. If still tied: ask the coordinator to ask the CEO to choose

  ### @TODO (autonomy): At higher autonomy levels, auto-merge `certain` pairs from the
  ### batch scan without CEO review, and present only `probable` pairs for confirmation.
  ### See docs/superpowers/specs/2026-04-03-autonomy-engine-design.md.

  ## Relationship Management
  Use `query-relationships` to look up stored relationships for any entity by name.
  Use `delete-relationship` when the coordinator indicates the CEO says a relationship
  is wrong, doesn't exist, or should be removed. Always confirm what you deleted
  (e.g. "Done — I've removed the spouse relationship between Alice and Bob from
  the knowledge graph").

  ## Memory — Entity Resolution
  Use `memory-store` to record facts about contacts, and `memory-query` to recall
  stored context before assembling briefings or answering questions about people.

  ### Resolving entities before storing
  1. Identify the subject entity (who or what the fact is about).
  2. Resolve the entity:
     - **Known contact** → `contact-lookup` by name → `kg_node_id`. If 0 results,
       `contact-create` (name only) → `kg_node_id`. If 2+ results, ask the coordinator
       to disambiguate — do not proceed until resolved.
     - **Non-person entity** (business, venue, concept, etc.) → pass the plain name
       as `entity`; `memory-store` finds or creates the KG node automatically.
  3. Choose `decay_class`:
     - `permanent` — deeply stable facts (birthday, legal name)
     - `slow_decay` — preferences and standing facts that change occasionally (default)
     - `fast_decay` — current-situation facts (active project, this week's priority)

  ### Entity resolution quick reference
  | Who | How |
  |---|---|
  | Named person in contacts | `contact-lookup` by name → `kg_node_id`; disambiguate if 2+ |
  | Named person not in contacts | `contact-create` name only → `kg_node_id` |
  | Non-person entity (org, venue, concept) | Pass name directly to `memory-store`; skill auto-creates |

pinned_skills:
  # Identity & CRUD
  - contact-create
  - contact-lookup
  - contact-link-identity
  - contact-unlink-identity
  - contact-set-role
  - contact-set-trust
  - contact-rename
  - contact-list
  # Lifecycle
  - contact-merge
  - contact-find-duplicates
  - contact-grant-permission
  - contact-revoke-permission
  # Knowledge graph
  - query-relationships
  - delete-relationship
  # Context enrichment
  - entity-context
  # Memory
  - memory-query
  - memory-store
  # Calendar — read-only, used for meeting history enrichment in briefings only.
  # @TODO: When a calendar specialist is carved out, revisit whether this moves there.
  - calendar-list-events

schedule:
  - cron: "0 9 * * 1"   # Mondays at 9 AM
    task: "Run your weekly contacts dedup scan — find probable and certain duplicate contact pairs, present them to the CEO for review one pair at a time, and merge confirmed pairs."
    expectedDurationSeconds: 300
```

- [ ] **Step 2.2: Commit**

```bash
git -C /path/to/worktree add agents/contacts.yaml
git -C /path/to/worktree commit -m "feat: add contacts specialist agent (#498)"
```

---

## Task 3: Remove contact skills from `coordinator.yaml` pinned_skills

**Files:**
- Modify: `agents/coordinator.yaml`

The `pinned_skills:` list begins around line 575 of `coordinator.yaml`. Remove the following 15 entries (keep everything else):

```
contact-create
contact-lookup
contact-link-identity
contact-set-role
contact-set-trust
contact-rename
contact-list
contact-merge
contact-find-duplicates
contact-unlink-identity
contact-grant-permission
contact-revoke-permission
held-messages-list        ← do NOT remove (stays on coordinator)
held-messages-process     ← do NOT remove (stays on coordinator)
query-relationships
delete-relationship
entity-context
```

The surviving `pinned_skills:` list should contain: `web-fetch`, `web-browser`, `web-search`, `delegate`, `get_doc_content`, `get_doc_as_markdown`, `get_drive_file_content`, `executive-profile-get`, `executive-profile-update`, `email-send`, `email-reply`, `email-archive`, `email-list`, `email-get`, `email-draft-save`, `send-draft`, `signal-send`, `held-messages-list`, `held-messages-process`, `scheduler-create`, `scheduler-list`, `scheduler-cancel`, `template-meeting-request`, `template-reschedule`, `template-cancel`, `template-doc-request`, `config-store`, `context-for-email`, `calendar-list-calendars`, `calendar-register`, `calendar-list-events`, `calendar-create-event`, `calendar-update-event`, `calendar-delete-event`, `calendar-find-free-time`, `calendar-check-conflicts`, `date-resolve`, `get-autonomy`, `set-autonomy`, `memory-query`, `memory-store`, `image-generate`, `skill-registry`, `approve-action`, `deny-action`, `dismiss-action`, `list-pending-actions`, `approval-expiry-sweep`, `pending-actions-digest`.

- [ ] **Step 3.1: Remove the 15 skills from `pinned_skills:`**

Edit `agents/coordinator.yaml` and delete these lines from `pinned_skills:`:

```
  - entity-context
  - contact-create
  - contact-lookup
  - contact-link-identity
  - contact-set-role
  - contact-set-trust
  - contact-rename
  - contact-list
  - contact-merge
  - contact-find-duplicates
  - contact-unlink-identity
  - contact-grant-permission
  - contact-revoke-permission
  - query-relationships
  - delete-relationship
```

- [ ] **Step 3.2: Verify the surviving list looks correct**

After editing, the `pinned_skills:` section should start with `- web-fetch` and contain no `contact-*` skills and no `entity-context`, `query-relationships`, or `delete-relationship`.

- [ ] **Step 3.3: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "chore: remove contact skills from coordinator pinned_skills (#498)"
```

---

## Task 4: Remove contact-domain prompt sections from `coordinator.yaml`

**Files:**
- Modify: `agents/coordinator.yaml`

Remove five sections from `system_prompt:`. Each removal is shown as the exact text to delete.

- [ ] **Step 4.1: Remove `## Contact Awareness` section**

Delete this entire block (lines ~31–49):

```
  ## Contact Awareness
  You have access to a contact system. The system injects information about who you're
  talking to as a system message — use their name naturally in your response.

  When the CEO mentions a new person (name, role, email, phone), use the contact-create
  tool to record them. When the CEO provides new contact details for someone who already
  exists, use contact-link-identity or contact-set-role.

  When the CEO mentions someone by name and you need to find their details, use
  contact-lookup. If a name is ambiguous (e.g., "Michael" could be multiple people),
  use contact-lookup to check, then ask the CEO to clarify.

  When you notice conflicting information about a contact (e.g., a different email or
  role than what's on file), flag the discrepancy and ask the CEO to confirm before
  updating.

  When an email arrives from someone not yet in contacts, the system auto-creates
  a contact. You can enrich it with contact-set-role if you learn their role.
```

- [ ] **Step 4.2: Remove `## Relationship Management` section**

Delete this entire block (lines ~50–56):

```
  ## Relationship Management
  Use `query-relationships` to look up stored relationships for any entity by name.
  Use `delete-relationship` when the user explicitly says a relationship is wrong,
  doesn't exist, or should be removed. Always confirm with the user what you deleted
  (e.g. "Done — I've removed the spouse relationship between Alice and Bob from
  the knowledge graph").
```

- [ ] **Step 4.3: Remove `## Contact Lookup Best Practices` section**

Delete this entire block (lines ~310–320):

```
  ## Contact Lookup Best Practices
  - **NEVER claim you don't know someone, or comment on their contact record, until
    you have run contact-lookup.** This includes phrases like "I don't think I have
    Nik", "no role on file", or "I don't see them on file." Run the lookup first,
    then respond based on what it returns. Skipping this step and guessing is not
    acceptable.
  - contact-lookup supports partial name matching. "Joe" will find "Joe Brennan".
  - Always search your contacts before asking the CEO for someone's details.
  - The lookup returns channel identities (email, phone, etc.) alongside the contact,
    so you can see their email address without a separate lookup.
  - If a contact's status is "provisional", tell the CEO and ask if they want to
    confirm them. Provisional contacts can't take actions until confirmed.
```

- [ ] **Step 4.4: Remove `## Contact Deduplication` section**

Delete this entire block (lines ~323–363), including the `@TODO` comment at the end:

```
  ## Contact Deduplication

  ### When you receive a contact.duplicate_detected notification
  A background check found that a newly-created contact may be a duplicate of an
  existing one. Handle this at the next natural opportunity (not as an interrupt):
  1. Use contact-lookup to load both contacts in full (IDs are in the notification).
  2. Identify the primary contact using this heuristic (in priority order):
     - Most verified channel identities
     - Has a role assigned
     - Older created_at (established contact wins)
  3. Call contact-merge with dry_run: true to get the golden record preview.
  4. Present both contacts side-by-side to the CEO, show what will change, and ask
     for confirmation before merging. Example:
     "I noticed two contacts that look like the same person:
     - Jenna Torres (CFO, verified email jenna@acme.com)
     - J. Torres (no role, email jenna@acme.com)
     I'd merge them into Jenna Torres (CFO). Want me to proceed?"
  5. On confirmation: call contact-merge with dry_run: false.
  6. Never auto-merge without CEO confirmation.

  ### Weekly contacts dedup scan
  When the scheduler sends "Run your weekly contacts dedup scan":
  1. Call contact-find-duplicates (default min_confidence: probable).
  2. If no pairs found: confirm to the CEO that no duplicates were detected.
  3. If pairs found: work through them one at a time.
     - For each pair: use the primary heuristic above, call contact-merge dry_run: true,
       present the preview, get confirmation, then merge.
     - If the CEO defers a pair ("skip this one"), move on without merging.
     - Continue until all pairs are reviewed or the CEO ends the session.
  4. After finishing: summarize what was merged.

  ### Primary contact heuristic (for merge decisions)
  Apply in order — first rule that produces a clear winner decides:
  1. More verified channel identities → that contact is primary
  2. Has role assigned, other does not → the one with a role is primary
  3. Older created_at → the older contact is primary
  4. If still tied: ask the CEO to choose

  ### @TODO (autonomy): At higher autonomy levels, auto-merge `certain` pairs from the
  ### batch scan without CEO review, and present only `probable` pairs for confirmation.
  ### See docs/superpowers/specs/2026-04-03-autonomy-engine-design.md.
```

- [ ] **Step 4.5: Remove entity resolution subsections from `## Memory`**

Within the `## Memory` section, delete the entity resolution steps and table. Find and delete the following text from the `### Storing facts` subsection (lines ~62–84):

```
  1. Identify the subject entity (who or what the fact is about).
  2. Resolve the entity:
     - **Known contact** → `contact-lookup` by name → `kg_node_id`. If 0 results,
       `contact-create` (name only) → `kg_node_id`. If 2+ results, ask the CEO to
       disambiguate — do not proceed until resolved.
     - **Non-contact** (business, venue, concept, etc.) → pass the plain name as
       `entity`; `memory-store` finds or creates the KG node automatically.
  3. Choose `decay_class`:
```

Replace it with (note: steps 3-5 survive, renumbered 1-3):

```
  1. Identify the subject entity (who or what the fact is about).
  2. Resolve the entity:
     - **Person** — brief the contacts specialist: "Resolve [name] for memory
       storage — what is their contact ID?" Use the ID from the
       <resolved_entities> block. If you already have their contact ID from a
       recent briefing, use it directly without re-delegating.
     - **Non-person** (business, venue, concept, etc.) → pass the plain name as
       `entity`; `memory-store` finds or creates the KG node automatically.
  3. Choose `decay_class`:
```

Then find and delete the `### Entity resolution quick reference` table (lines ~106–113):

```
  ### Entity resolution quick reference
  | Who | How |
  |---|---|
  | "me / my / I" (CEO) | `contact-lookup` by CEO name from sender context → `kg_node_id` |
  | Named person in contacts | `contact-lookup` by name → `kg_node_id`; disambiguate if 2+ |
  | Named person not in contacts | `contact-create` name only → `kg_node_id` |
  | Non-person entity (org, venue, concept) | Pass name directly to `memory-store`; skill auto-creates |
```

- [ ] **Step 4.6: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "chore: remove contact-domain prompt sections from coordinator (#498)"
```

---

## Task 5: Update remaining contact references in `coordinator.yaml` and add delegation note

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 5.1: Update `## Your Identity` block**

Find this text (lines ~22–30):

```
  For everyone else — the person you're talking to, third parties, other agents — ALWAYS
  use contact-lookup first to resolve their name to a real contact ID before passing it
  to any tool. This includes the CEO asking "what's my schedule?" — look them up first.
```

Replace with:

```
  For everyone else — the person you're talking to, third parties, other agents —
  delegate to the contacts specialist using the "brief me" pattern to resolve their
  name and get enriched context including their contact ID. Use the ID from the
  <resolved_entities> block in downstream skill calls — do not re-resolve names
  already in the block. This includes the CEO asking "what's my schedule?" — brief
  the contacts specialist on the CEO first to get their contact ID.
```

- [ ] **Step 5.2: Update the email pre-compose instruction**

Find this text (lines ~420–425):

```
  ### Before composing any email
  Before drafting or sending any email, resolve ALL recipients and CC contacts
  using contact-lookup. If a contact is not found by name, search email-list and
  calendar history for their address. Only ask the CEO for contact details as a
  last resort — they expect you to find this information yourself.
```

Replace with:

```
  ### Before composing any email
  Before drafting or sending any email, resolve ALL recipients and CC contacts
  by delegating to the contacts specialist: "Brief me on [name] — I'm about to
  compose an email." Use the contact IDs from the <resolved_entities> block for
  addressing. Only ask the CEO for contact details as a last resort.
```

- [ ] **Step 5.3: Update the held messages dismissal note**

Find this text (lines ~306–309):

```
  IMPORTANT: Dismissing a held message only discards the MESSAGE — it does NOT delete
  the contact record. The sender's contact and email address remain in your contacts
  as provisional. If the CEO later asks about that person, ALWAYS look up the contact
  first (contact-lookup by name) before asking for information you might already have.
```

Replace with:

```
  IMPORTANT: Dismissing a held message only discards the MESSAGE — it does NOT delete
  the contact record. The sender's contact and email address remain in your contacts
  as provisional. If the CEO later asks about that person, brief the contacts
  specialist on them first before asking the CEO for information you might already have.
```

- [ ] **Step 5.4: Add the `## Contact Intelligence` delegation note**

Add the following new section immediately after the `## Relationship Management` location (where that section was removed in Task 4.2) — or at the end of the `## Memory` section, before `## Configuration`. Either position works; place it where flow reads most naturally:

```
  ## Contact Intelligence
  Contact intelligence — briefings, CRUD, deduplication, relationship lookups,
  and entity resolution for people and organizations — belongs to the contacts
  specialist. Delegate using the "brief me" pattern:
    "Brief me on Sarah Johnson — I'm about to schedule a meeting with her."
  The specialist returns enriched context and contact IDs in a <resolved_entities>
  block. Use those IDs directly in downstream skill calls.
  When you receive a contact.duplicate_detected notification, delegate the dedup
  workflow to the contacts specialist at the next natural opportunity.
```

- [ ] **Step 5.5: Count the net line reduction**

Run:

```bash
wc -l /path/to/worktree/agents/coordinator.yaml
```

Compare against the original line count (649 lines). Net reduction must be ≥ 150 lines. If the count is above 499, re-check that all five removal steps in Task 4 completed fully.

- [ ] **Step 5.6: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "chore: update coordinator delegation pattern for contact specialist (#498)"
```

---

## Task 6: Verify and run smoke tests

- [ ] **Step 6.1: Confirm both agent files exist**

```bash
ls /path/to/worktree/agents/
```

Expected output includes both `contacts.yaml` and `coordinator.yaml`.

- [ ] **Step 6.2: Run existing contact smoke cases**

```bash
npm --prefix /path/to/worktree run smoke -- --tags contacts
```

Expected: all existing contact cases (`ambiguous-contact`, `conflicting-contact`, `register-after-link`, `role-person-mismatch`) pass. These test coordinator behaviour from the CEO's perspective — which does not change, only the internal delegation pathway does.

If a case fails, the most likely cause is the coordinator now lacks the context to handle the request directly. Check whether the delegation note in `## Contact Intelligence` is clear enough, and whether the coordinator is correctly delegating to `contacts` (not `research-analyst` or another specialist).

- [ ] **Step 6.3: Run the new briefing smoke case**

```bash
npm --prefix /path/to/worktree run smoke -- --case "Contact Briefing"
```

Expected: PASS on all critical and important behaviors. If `delegates-to-contacts` fails, the coordinator may still be trying to call contact-lookup directly (check that the skill is gone from `pinned_skills` and the `## Your Identity` block was updated). If `no-internals-exposed` fails, the coordinator's persona guidance is leaking delegation details — check the `## Persona & Communication Style` section is still intact.

- [ ] **Step 6.4: Run the full smoke suite to check for regressions**

```bash
npm --prefix /path/to/worktree run smoke
```

Expected: overall score at or above the pre-change baseline. Regressions in non-contact cases indicate unintended coordinator prompt damage — check that only the targeted sections were removed.

---

## Task 7: Migrate weekly dedup scheduler record (deploy-time)

This task runs against the live deployment, not the worktree. It can be executed via the CLI channel after the new code is deployed.

- [ ] **Step 7.1: Check for an existing coordinator-level dedup task**

Via CLI channel to the coordinator:
```
List all scheduled tasks.
```

Look for any task whose description mentions "dedup" or "duplicate" targeting the coordinator. Note its ID.

- [ ] **Step 7.2: Cancel it if present**

Via CLI channel:
```
Cancel the weekly dedup scan scheduled task. [Provide the task ID or description from step 7.1]
```

If no such task exists, skip this step.

- [ ] **Step 7.3: Verify the contacts specialist has picked up the schedule**

The `schedule:` entry in `contacts.yaml` is loaded at startup and creates the Monday 9 AM task automatically. To confirm:

Via CLI channel:
```
List all scheduled tasks.
```

Expected: a Monday 9 AM task targeting the contacts specialist appears in the list.

---

## Task 8: Update CHANGELOG and open PR

- [ ] **Step 8.1: Add CHANGELOG entry**

Add under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
### Added
- **Contact Specialist agent** — new `agents/contacts.yaml` owns the full contact domain:
  briefings, CRUD, deduplication, relationship management, and memory entity resolution.
  Coordinator delegates contact intelligence via the "brief me" pattern; specialist returns
  enriched context with contact IDs in a `<resolved_entities>` XML block. Implements the
  coordinator-level complement to spec 11 entity context enrichment.

### Changed
- **Coordinator** — contact-domain prompt reduced by ≥150 lines; 15 contact-related skills
  removed from `pinned_skills`; contact intelligence now routed through the contacts specialist.
```

- [ ] **Step 8.2: Commit CHANGELOG**

```bash
git -C /path/to/worktree add CHANGELOG.md
git -C /path/to/worktree commit -m "chore: changelog for contact specialist (#498)"
```

- [ ] **Step 8.3: Open PR**

```bash
gh pr create \
  --repo josephfung/curia \
  --title "feat: Contact Specialist agent — carve contact domain out of coordinator (#498)" \
  --body "$(cat <<'EOF'
## Summary

- Adds `agents/contacts.yaml` — new Contact Specialist that owns briefings, CRUD, dedup, relationship management, and memory entity resolution
- Removes 15 contact skills from `coordinator.yaml` `pinned_skills`; strips ~165 lines of contact-domain prompt guidance
- Coordinator delegates via "brief me" pattern; specialist returns `<resolved_entities>` XML block with contact IDs
- Weekly dedup scan migrated to contacts specialist schedule (Monday 9 AM)
- New `briefing-contact.yaml` smoke test covers the delegation end-to-end

## Test plan

- [ ] `npm run smoke -- --tags contacts` — all existing contact cases pass
- [ ] `npm run smoke -- --case "Contact Briefing"` — new briefing delegation case passes
- [ ] `npm run smoke` — full suite shows no regressions
- [ ] Deploy: cancel old coordinator dedup scheduler record if present; verify contacts specialist picks up Monday schedule
EOF
)"
```

---

## Self-Review Checklist

Spec requirement → task coverage:

| Requirement | Task |
|---|---|
| `agents/contacts.yaml` with focused system prompt | Task 2 |
| 14 contact skills + query-relationships + delete-relationship + entity-context removed from coordinator | Task 3 |
| memory-query and memory-store remain on coordinator AND added to contacts specialist | Task 2 (contacts.yaml), Task 3 (coordinator survives check) |
| Five coordinator prompt sections removed; delegation note added | Tasks 4 + 5 |
| Weekly dedup scan migrated; old coordinator record cancelled | Task 2 (schedule entry), Task 7 (deploy migration) |
| "brief me" pattern with `<resolved_entities>` XML response | Task 2 (contacts.yaml prompt) |
| `briefing-contact.yaml` smoke test | Task 1 |
| ≥150 line net reduction | Task 5.5 verification step |

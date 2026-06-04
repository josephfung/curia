# 09 — Contacts & Identity

## Overview

The contact system translates natural-language references to people ("Jenna is my CFO") into verifiable, actionable identities that the framework can use to authenticate senders, authorize actions, and route responses across channels. It bridges the gap between the knowledge graph (rich facts about people) and the channel layer (raw sender IDs on inbound messages).

---

## Data Model

Three tables handle identity resolution, verification, and authorization. Rich context about a person (relationships, history, preferences) lives in the knowledge graph — the contact tables are a thin, fast index for dispatch-time lookups.

### contacts

```sql
CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kg_node_id      UUID REFERENCES kg_nodes(id),
  display_name    TEXT NOT NULL,
  role            TEXT,
  notes           TEXT,
  -- Canonical attributes (migration 048; see "Canonical Attributes" below)
  preferred_name  TEXT,
  title           TEXT,
  organization    TEXT,
  primary_email   TEXT,    -- CHECK: email format
  primary_phone   TEXT,    -- CHECK: E.164 (^\+[1-9][0-9]{6,14}$)
  timezone        TEXT,    -- IANA tz string, e.g. America/New_York
  locale          TEXT,    -- CHECK: BCP 47, e.g. en-US
  location        TEXT,
  pronouns        TEXT,
  linkedin_url    TEXT,    -- CHECK: starts with http(s)://
  bio             TEXT,    -- CHECK: <= 500 chars
  birthday        TEXT,    -- CHECK: YYYY-MM-DD or --MM-DD (year omitted)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contacts_kg_node ON contacts (kg_node_id) WHERE kg_node_id IS NOT NULL;
CREATE INDEX idx_contacts_role ON contacts (role) WHERE role IS NOT NULL;
```

- `display_name` — the working name the Coordinator uses in messages ("Jenna Torres"). Populated from the KG person node's `preferred_name` or `given_name + family_name`.
- `role` — denormalized from the KG for fast access during authorization checks. Kept in sync when the KG node's role property changes.
- `kg_node_id` — links to the `kg_nodes` person node that holds structured name fields (`given_name`, `family_name`, `preferred_name`, `pronouns`, `title`), relationships, and temporal metadata.
- `notes` — CEO's freeform notes about the contact ("prefers text over email", "travels a lot in Q4").
- **Canonical attributes** (`preferred_name` … `birthday`) — 12 structured profile fields persisted directly on the contact row (see the dedicated section below).

### contact_channel_identities

```sql
CREATE TABLE contact_channel_identities (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,
  channel_identifier  TEXT NOT NULL,
  label               TEXT,
  verified            BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ,
  source              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(channel, channel_identifier)
);

-- UNIQUE constraint above creates an implicit index on (channel, channel_identifier)
CREATE INDEX idx_cci_contact ON contact_channel_identities (contact_id);
```

- One contact can have **multiple identifiers per channel** (work email + personal email, work phone + personal phone). Each is a separate row.
- The `UNIQUE(channel, channel_identifier)` constraint prevents two *different* contacts from claiming the same identifier, but allows one contact to have many identifiers on the same channel.
- `label` — optional tag like `"work"`, `"personal"`, `"assistant"` for context.
- `verified` — binary: the CEO has confirmed this identity link, or they haven't. There is no intermediate confidence level. Unverified identities are treated as unknown senders for action gating.
- `source` — how this identity was established:

| Source | Meaning | Verified? |
|---|---|---|
| `ceo_stated` | CEO explicitly provided the identifier ("Jenna's email is jenna@acme.com") | Yes |
| `email_participant` | Extracted from To/CC on an email the CEO sent or was part of | Yes |
| `crm_import` | Pulled from the CEO's CRM during an action | Yes |
| `calendar_attendee` | Extracted from a calendar event | Yes |
| `self_claimed` | The sender identified themselves ("Hi, it's Jenna") | No |

CEO statements, email participants, and authoritative external sources (CRM, calendar) are verified on creation — they represent the CEO's own data and actions. Self-claimed identities require explicit CEO confirmation before `verified` flips to `true`.

### contact_auth_overrides

```sql
CREATE TABLE contact_auth_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  permission      TEXT NOT NULL,
  granted         BOOLEAN NOT NULL,
  granted_by      TEXT NOT NULL DEFAULT 'ceo',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,

  UNIQUE(contact_id, permission)
);

CREATE INDEX idx_cao_contact_perm ON contact_auth_overrides (contact_id, permission)
  WHERE revoked_at IS NULL;
```

- `granted: true` — explicitly grants a permission beyond the role's defaults.
- `granted: false` — explicitly denies a permission that the role's defaults would allow.
- `revoked_at` — soft-delete timestamp. When an override is revoked, the row is preserved with `revoked_at` set for audit history. Only rows with `revoked_at IS NULL` are active.
- `UNIQUE(contact_id, permission)` — prevents contradictory overrides for the same contact and permission. Updating an override upserts the existing row.
- Overrides always win over role defaults.

---

## Canonical Attributes

Historically everything the system "knew" about a person lived as `kg_nodes` of
`type='fact'`, surfaced as confidence-scored bullet points. That invited two failures:
agents **hallucinated** values (calendar IDs, addresses) when the fact list was thin, and
specialists (calendar, email composition, research) each re-parsed fact bullets for the
same handful of attributes. v0.33 promotes 12 commonly-needed attributes to first-class,
nullable `TEXT` columns on the `contacts` row (migration `048_add_contact_canonical_attributes.sql`).

| Column | Notes |
|---|---|
| `preferred_name` | Short/familiar form; falls back to `display_name`. |
| `title` | Current job title. |
| `organization` | Current employer (free-text). |
| `primary_email` | Lowercased; app-layer validated against `contact_channel_identities`. DB CHECK enforces email format. |
| `primary_phone` | E.164 (`^\+[1-9][0-9]{6,14}$`). |
| `timezone` | IANA tz string (e.g. `America/New_York`). |
| `locale` | BCP 47 (e.g. `en-US`). |
| `location` | City/region (free-text). |
| `pronouns` | Free-text. |
| `linkedin_url` | Must start with `http(s)://`. |
| `bio` | Short narrative, ≤ 500 chars. |
| `birthday` | `YYYY-MM-DD`, or `--MM-DD` when the year is omitted. |

### Writing canonical attributes

There are three write paths, all converging on `ContactService`:

1. **`contact-update` skill** — the direct path for an agent to set canonical attributes
   (`action_risk: low`). Pinned to coordinator, ceo-inbox, research-analyst, and contacts.
   Normalizes phone numbers to E.164.
2. **Redirected fact writes** — `memory-store` and `extract-facts` detect a write whose
   attribute key maps to a canonical field (the `canonical-attribute-guard`,
   whitespace-trimmed) and redirect it to `ContactService` instead of creating a KG fact
   node. The skill result reports a `redirected` counter and a `redirected_to_contact`
   action with the `contact_id`. **New KG fact writes for these attributes are stopped** —
   the column is the single source of truth.
3. **One-time backfill** — `scripts/backfill-contact-attributes.ts`
   (`npm run backfill:contact-attributes`) populates the columns from existing KG facts via
   a 3-hop join with per-column highest-confidence tiebreaking. Safe to re-run (only touches
   NULL columns).

### Reading canonical attributes: entity-context

`EntityContext.contact` exposes all 12 fields as structured values (see
[spec 11 — Entity Context Enrichment](11-entity-context-enrichment.md)), so an agent reads
a typed field rather than reasoning over a scored fact list. `context-for-email` prefers
`contact.primaryEmail` and surfaces `contact.preferredName` for salutations. Rich, non-
canonical knowledge about a person (relationships, history, preferences) continues to live
in the knowledge graph.

---

## Contact Resolution

The contact resolver runs in the **dispatch layer**, on every inbound message, *before* the Coordinator sees it. Resolution is deterministic — a simple indexed DB query, no LLM involved.

### Inbound Sender Resolution

```
Inbound message arrives
  channel: "signal", sender_id: "+15550001111"
        │
        ▼
  SELECT c.id, c.display_name, c.role, c.kg_node_id, cci.verified
  FROM contact_channel_identities cci
  JOIN contacts c ON c.id = cci.contact_id
  WHERE cci.channel = $1 AND cci.channel_identifier = $2
        │
    ┌───┴────┐
    │ Match? │
    ▼        ▼
   YES      NO → Tag as unknown_sender, apply channel policy
    │
    ▼
  Is cci.verified = true?
    │
  ┌─┴──┐
  YES   NO → Tag as unverified_sender, treat as unknown for action gating
  │
  ▼
  Enrich InboundMessage with:
    contact_id, display_name, role, kg_node_id, verification_status
```

The enriched message is what the Coordinator receives. Instead of "Signal number +15550001111 sent a message," the Coordinator sees "Jenna Torres (CFO, verified) sent a message."

### Participant Extraction

When the CEO sends a message that involves other people (email with To/CC recipients, mentions in conversation), the Coordinator extracts participants and runs them through the resolver:

1. **Email headers** — To and CC addresses are extracted by the email channel adapter and included in `InboundMessage.metadata.participants`.
2. **Conversation mentions** — the Coordinator extracts named entities from the CEO's messages during normal processing.
3. **Calendar/CRM lookups** — when an action requires contacting someone, the Coordinator queries external sources and resolves or creates contacts from the results.

For each extracted participant:
- If a matching contact exists → use it (and enrich with any new channel identifiers)
- If no match → create a new contact with the available information

---

## Identity Establishment

Contacts are built up incrementally through three paths. The CEO doesn't need to provide everything at once.

### Path 1: Proactive (CEO mentions someone)

The CEO mentions a person in conversation. The Coordinator extracts entities and creates or updates the contact.

**Full identifier provided:**
> CEO: "Jenna Torres is my CFO. Her email is jenna@acme.com and she's on Signal at +15550001111."

→ Creates KG person node, contact record, and two verified channel identities (source: `ceo_stated`).

**Partial mention (no identifiers):**
> CEO: "My CFO Jenna attends all board meetings."

→ Creates KG person node and contact record with role "CFO", but no channel identities yet. Identifiers get attached later through reactive matching or additional CEO statements.

### Path 2: Reactive (unknown sender arrives)

An unknown sender messages on a channel. The system applies channel-dependent policy and asks the CEO for identification.

**Flow:**
1. Contact resolver finds no match for `(channel, sender_id)`
2. Channel-dependent unknown sender policy applies (see below)
3. CEO identifies the sender → channel identity linked to existing or new contact (source: `ceo_stated`, verified: `true`)
4. Held message is re-processed with the now-resolved contact context

### Path 3: External Source (CRM, calendar, address book)

The Coordinator needs to contact someone for an action (e.g., "let my 2pm meeting know I'm running late"). It queries external authoritative sources to find contact information.

**Flow:**
1. Coordinator looks up the meeting via calendar skill → finds attendee "Sarah Chen, sarah.chen@acme.com"
2. Resolver checks if sarah.chen@acme.com is a known contact
3. If not → creates contact from CRM/calendar data (source: `calendar_attendee` or `crm_import`, verified: `true`)
4. If the action requires a channel the contact doesn't have (e.g., need phone number for SMS) → queries additional sources (CRM) to enrich

External authoritative sources are the CEO's own systems. Identities from these sources are treated as verified because the CEO trusts their own CRM and calendar.

---

## Principal Contact Resolution

The **principal** is the human Curia is built to serve — the CEO, founder, or operator the deployment belongs to. Exactly one contact is designated as the principal per deployment. Agents that need to send messages to, look up calendars for, or otherwise act on behalf of the principal resolve that contact via a single platform-managed handle, rather than each agent re-discovering "who is the CEO?" on every cron tick.

### Bootstrap-time materialization

At startup, `contactService.findContactBySystemRole('principal')` resolves the principal's `contacts.id` (a UUID) and the runtime caches it. The principal's contact ID is immutable for a deployment, so bootstrap-time resolution is correct — there is no per-turn refresh.

### Exposure to agents: `${principal_contact_id}`

Agent system prompts can reference `${principal_contact_id}` as a runtime template variable. The placeholder is interpolated by `interpolateRuntimeContext()` in `src/agents/loader.ts` when the agent's prompt is materialized, alongside the existing `${agent_contact_id}` (the agent's own identity).

Both placeholders are **opt-in**: only agents that reference the placeholder pay the prompt-bytes cost. Agents that don't need to reach the principal — research-analyst, expense-tracker on receipts, etc. — simply don't reference it and the platform doesn't expand their attack surface with addresses they don't need.

If `findContactBySystemRole('principal')` returns nothing (fresh deployment, before bootstrap), the placeholder resolves to an empty string and a one-time warning is logged. The same defense-in-depth UUID-format check used for `${agent_contact_id}` applies — any non-UUID value resolves to an empty string, so a future change to the ID source can't accidentally inject arbitrary text into the system prompt.

### What is pre-resolved and what is not

The platform pre-resolves (caches at bootstrap) only the principal's `contacts.id`. It does **not** bootstrap-inject verified email addresses, Signal numbers, calendar IDs, timezone, or any other attribute — those can change within a deployment lifetime, so bootstrap-time injection would go stale.

Agents that need any of those values call `entity-context` with `${principal_contact_id}` at the start of their run. As of v0.33 the canonical attributes (including `timezone`, `primary_email`, `title`, `organization`) come back as structured fields on `EntityContext.contact` rather than as confidence-scored KG facts (see the Canonical Attributes section above) — so the agent reads a typed value instead of reasoning over a fact list. This keeps the live values fresh and consolidates the "who is the principal and how do I reach them?" question into a single skill call per agent run, instead of multiple `contact-lookup`-by-role calls scattered across the agent's pipeline.

### Why not auto-injection?

The platform deliberately does *not* auto-inject the principal contact ID into every agent prompt. Two reasons:

1. **Attack surface.** Agents that have no business contacting the principal directly (specialist agents like research-analyst that should report through the coordinator) would be invited to do so. The opt-in pattern keeps the surface narrow.
2. **Consistency.** The same opt-in pattern is established for `${agent_contact_id}`. Two placeholders with two different injection rules would be confusing.

The durable countermeasure to poorly-written agents that hardcode the principal's addresses is the `Reaching the principal` convention documented in `CLAUDE.md`, plus reviewer discipline — not silent injection.

---

## Unknown Sender Policy

When an inbound message can't be matched to any contact, the system's response depends on the originating channel's trust level:

| Channel | Trust | Unknown Sender Policy |
|---|---|---|
| **CLI** | `high` | N/A — always the primary user |
| **Signal** | `high` | Hold silently, notify CEO |
| **HTTP API** | `medium` | Reject with 401 (unknown token) |
| **Email** | `low` | Hold silently, notify CEO |

Policy is configurable per channel in `config/default.yaml`:

```yaml
# config/default.yaml
contacts:
  unknown_sender_policy:
    signal: hold_and_notify
    email: auto_reply
    http_api: reject
```

Held messages are queued in working memory with a `held_for_identification` flag. The Coordinator presents them to the CEO at the next opportunity:

> "I received a Signal message from an unknown sender (+15559999999) who says they're Jen Torres, asking for Q3 numbers. Do you know them?"

If the CEO identifies the sender, the held message is re-processed with full contact context. If the CEO says "I don't know them," the held message is discarded and the sender remains unresolved.

**Rate limiting:** A maximum of 20 held messages per channel are queued at any time (configurable). When the cap is reached, the oldest held message is discarded. This prevents a flood of unknown-sender messages from consuming unbounded working memory.

> **Open question:** Held message expiration is deferred. Messages are currently held
> indefinitely until the CEO acts. A future discard/expiration process will need
> judgment and oversight — not a simple TTL timer. The CEO may want to batch-review
> old held messages, or have Curia summarize and triage them.

---

## Authorization Model

Authorization is evaluated through a three-layer stack where per-contact overrides take precedence over role defaults, and channel trust acts as a final gate.

### Layer 1: Role Defaults (Config)

Each role has default permissions and default denials, defined in YAML configuration:

```yaml
# config/role-defaults.yaml
roles:
  cfo:
    description: "Chief Financial Officer"
    default_permissions:
      - view_financial_reports
      - view_board_materials
      - request_action_items
      - schedule_meetings
    default_deny:
      - send_on_behalf
      - see_personal_calendar

  board_member:
    description: "Board of Directors member"
    default_permissions:
      - view_board_materials
      - request_meeting_notes
    default_deny:
      - view_financial_reports
      - access_internal_docs

  direct_report:
    description: "Direct report to CEO"
    default_permissions:
      - schedule_meetings
      - request_action_items
    default_deny:
      - view_board_materials
      - view_financial_reports

  advisor:
    description: "External advisor (legal, financial, strategic)"
    default_permissions:
      - schedule_meetings
    default_deny:
      - access_internal_docs
      - send_on_behalf

  investor:
    description: "Investor or board observer"
    default_permissions:
      - view_board_materials
      - request_meeting_notes
    default_deny:
      - view_financial_reports
      - access_internal_docs

  spouse:
    description: "Spouse or life partner"
    default_permissions:
      - see_personal_calendar
      - book_travel
      - manage_personal_appointments
    default_deny:
      - view_financial_reports
      - access_internal_docs

  family_member:
    description: "Family member"
    default_permissions:
      - see_personal_calendar
    default_deny:
      - "*"

  unknown:
    description: "Fallback for contacts with no assigned role"
    default_permissions: []
    default_deny:
      - "*"
```

Roles are **open-ended** — the CEO can create new roles at any time by assigning a role name the system hasn't seen before. When the Coordinator encounters an unknown role, it falls back to `unknown` defaults and asks the CEO what permissions are appropriate. The CEO can either define permissions ad-hoc (stored as per-contact overrides) or create a reusable role entry.

### Layer 2: Per-Contact Overrides (DB)

Stored in `contact_auth_overrides`. Explicit grants and denials that override role defaults:

- CEO says "Jenna can send emails on my behalf" → grant `send_on_behalf` for Jenna
- CEO says "Don't let board members see the Q3 financials yet" → the Coordinator creates individual `view_financial_reports` deny overrides for each current contact with role `board_member`. Note: future contacts assigned the `board_member` role will not inherit these overrides — the Coordinator should mention this to the CEO and offer to update role defaults instead if the restriction is meant to be permanent.

### Layer 3: Channel Trust

Even if a contact's role and overrides permit an action, the originating channel's trust level must be sufficient. This uses the existing trust policy from [06-audit-and-security.md](06-audit-and-security.md#trust-gated-actions):

```yaml
# config/default.yaml
trust_policy:
  financial_actions: high
  data_export: high
  scheduling: medium
  information_queries: low
```

When an action's trust requirement exceeds the channel's trust level, the Coordinator escalates: "Jenna asked for the Q3 financials via email. For security, I need her to confirm via Signal."

### Authorization Check Flow

```
Verified contact requests an action
        │
        ▼
  1. Check contact_auth_overrides FIRST
     → Explicit grant? → use it (skip role defaults)
     → Explicit denial? → use it (skip role defaults)
     → No override? → fall through to step 2
        │
        ▼
  2. Check role defaults
     → Is the action in default_permissions? → allowed
     → Is the action in default_deny? → denied
     → Not listed in either? → escalate to CEO
        │
        ▼
  3. Check channel trust level (final gate)
     → Channel trust >= action's trust requirement? → proceed
     → Channel trust < action's trust requirement? → escalate to CEO
        │
        ▼
  ALLOW / DENY / ESCALATE
```

### Permissions Registry

Permissions are semantic labels the Coordinator interprets — not hard-coded enum values checked in application code. A soft registry provides structure and sensitivity metadata:

```yaml
# config/permissions.yaml
permissions:
  view_financial_reports:
    description: "Access quarterly reports, P&L, budgets"
    sensitivity: high
  view_board_materials:
    description: "Access board decks, minutes, resolutions"
    sensitivity: high
  see_personal_calendar:
    description: "View personal/non-work calendar events"
    sensitivity: medium
  book_travel:
    description: "Book flights, hotels, and transportation"
    sensitivity: medium
  schedule_meetings:
    description: "Schedule or reschedule meetings on CEO's calendar"
    sensitivity: low
  request_action_items:
    description: "Request action items from meetings or tasks"
    sensitivity: low
  request_meeting_notes:
    description: "Request notes or minutes from meetings"
    sensitivity: low
  send_on_behalf:
    description: "Send messages or emails as the CEO"
    sensitivity: high
  access_internal_docs:
    description: "Access internal company documents"
    sensitivity: medium
  see_personal_calendar:
    description: "View personal (non-work) calendar"
    sensitivity: medium
  manage_personal_appointments:
    description: "Create, modify, or cancel personal appointments"
    sensitivity: medium
```

The `sensitivity` field maps directly to channel trust requirements: `high` sensitivity requires a `high` trust channel, `medium` requires `medium` or higher, `low` has no channel restriction. When the trust policy in [06-audit-and-security.md](06-audit-and-security.md#trust-gated-actions) defines an explicit rule for an action category, that rule takes precedence over the generic sensitivity mapping. New permissions can be added at any time — the Coordinator normalizes CEO requests to existing permission names when possible ("can she see my calendar?" → `see_personal_calendar`) and creates new entries when needed.

---

## Contact Management Skills

Contact CRUD operations are exposed as skills, invoked by the Coordinator during conversation:

| Skill | Description |
|---|---|
| `contact.create` | Create a new contact (and optionally link to existing KG person node) |
| `contact.link-identity` | Add a channel identity to an existing contact |
| `contact.unlink-identity` | Remove a channel identity from a contact |
| `contact.set-role` | Set or change a contact's role |
| `contact.grant-permission` | Add a permission override (grant or deny) |
| `contact.revoke-permission` | Remove a permission override |
| `contact.lookup` | Look up a contact by name, role, or channel identifier |
| `contact.list` | List contacts filtered by role, status (`confirmed`, `provisional`, `blocked`), or limit. Filtering is DB-level for performance. |
| `contact.merge` | Merge two contacts into one (consolidates channel identities and overrides) |

All contact mutations are audit-logged. The Coordinator confirms changes with the CEO before writing:

> Coordinator: "I'll add Jenna's personal phone (+15550002222) to her contact. Confirmed?"
> CEO: "Yes"
> → `contact.link-identity` invoked

---

## Bus Events

New event types added to the bus:

```typescript
// contact.resolved — dispatch layer publishes when a sender is matched
type ContactResolvedEvent = {
  type: 'contact.resolved';
  contact_id: string;
  display_name: string;
  role: string | null;
  kg_node_id: string | null;
  verification_status: 'verified' | 'unverified';
  channel: string;
  channel_identifier: string;
};

// contact.unknown — dispatch layer publishes when a sender can't be matched
type ContactUnknownEvent = {
  type: 'contact.unknown';
  channel: string;
  sender_id: string;
  channel_trust_level: 'low' | 'medium' | 'high';
  held_message_id: string;
};
```

Both events are audit-logged before delivery (write-ahead, per [06-audit-and-security.md](06-audit-and-security.md)).

---

## Integration with Existing Specs

| Spec | Integration Point |
|---|---|
| **01 — Memory System** | Contact records link to KG person nodes via `kg_node_id`. Structured name fields (`given_name`, `family_name`, `preferred_name`) are KG node properties. The contact table is an index, not a duplicate of KG data. |
| **02 — Agent System** | Coordinator receives enriched messages with contact context. Role and permissions are included in the Coordinator's system prompt context for each conversation. Specialist agents never see external contact info directly. |
| **03 — Skills & Execution** | Contact management operations (`contact.create`, `contact.link-identity`, etc.) are skills with manifests in `skills/contact/`. |
| **04 — Channels** | Channel adapters produce `InboundMessage` with `sender_id`. The contact resolver in the dispatch layer enriches this before routing to the Coordinator. Email adapter extracts To/CC participants into `metadata.participants`. |
| **05 — Error Recovery** | Contact resolution and authorization check failures are handled as `AgentError` types. If the contacts DB is unreachable, the resolver degrades gracefully: messages are tagged as `resolution_failed` and treated as unknown senders (safe default). Error budgets from spec 05 apply to contact management skills. |
| **06 — Audit & Security** | Every identity resolution is audit-logged. Failed resolution attempts are logged for security review. Authorization decisions (allow/deny/escalate) are not yet audit-logged — the `AuthorizationService` is a pure function with no bus or logger access; logging is planned (see Implementation Status). The per-channel sender allowlist from spec 04 is fully superseded by contact resolution once the contacts system is deployed — all channels use the contact resolver, and the old allowlist config is ignored. Specs 04 and 06 should be updated to note this deprecation. |
| **08 — Operations** | Contact tables added via migration. Role defaults and permissions registry added to `config/`. |

---

## Migration

Single migration file adds the three tables:

```
src/db/migrations/XXX_create_contacts.sql
```

The migration depends on `kg_nodes` existing (for the foreign key), so it must run after the knowledge graph migration.

---

## Security Considerations

- **No PII in logs** — contact display names and channel identifiers are audit-logged (they're operational data), but raw message content from unknown senders is redacted per [06-audit-and-security.md](06-audit-and-security.md#redaction).
- **Spoofing defense** — a spoofed email From header might match a known contact's email, but the email channel's low trust level prevents consequential actions. The Coordinator will ask for Signal/CLI confirmation before acting on sensitive requests from email.
- **Impersonation on new channels** — someone claiming to be a known contact on a new channel identity is `self_claimed` (unverified) until the CEO confirms. The Coordinator never auto-promotes self-claimed identities.
- **Automatic promotion of provisional contacts** — provisional contacts are automatically promoted to `confirmed` when any of three signals is detected: (1) Curia has sent an outbound message to the contact, (2) the CEO has sent them an email (detected via Sent folder scan), or (3) the CEO accepted a calendar event with the contact as an attendee. A daily 8 AM contacts agent sweep reconciles provisional contacts against these signals. The `contact-register` skill returns `promoted: true` and `promotion_signal` when a promotion occurs. This is distinct from self-claimed identities — auto-promotion only applies to provisional contacts whose email was established via a trusted source (email headers, calendar), never to self-claimed channel identities.
- **Contact deletion** — removing a contact also cascades to channel identities and auth overrides (ON DELETE CASCADE). The KG person node is not deleted — it retains historical facts even if the contact record is removed.
- **Allowlist supersession** — once the contact system is deployed, it fully replaces the per-channel sender allowlist from [04-channels.md](04-channels.md#sender-allowlists). All channels use the contact resolver pipeline. Unknown senders follow the unknown sender policy defined in this spec. The old allowlist configuration is ignored. Specs 04 and 06 should be updated to mark the allowlist as deprecated.

---

## Implementation Checklist

- [ ] Migration: `contacts`, `contact_channel_identities`, `contact_auth_overrides` tables
- [ ] Contact resolver in dispatch layer (sender lookup + message enrichment)
- [ ] Participant extraction from email headers (To/CC → metadata.participants)
- [ ] Contact management skills (`contact.create`, `contact.link-identity`, etc.)
- [ ] Bus event types: `contact.resolved`, `contact.unknown`
- [ ] Role defaults config (`config/role-defaults.yaml`)
- [ ] Permissions registry config (`config/permissions.yaml`)
- [ ] Unknown sender policy config and enforcement
- [ ] Authorization check in Coordinator context assembly (role → overrides → trust)
- [ ] Audit logging for all identity resolution and authorization decisions
- [ ] Integration tests: proactive identity establishment
- [ ] Integration tests: reactive identity establishment (unknown sender flow)
- [ ] Integration tests: external source enrichment (CRM/calendar → contact)
- [ ] Integration tests: authorization check (role defaults + overrides + trust)

---

## Implementation Status

| Item | Status |
|---|---|
| Migration: `contacts`, `contact_channel_identities`, `contact_auth_overrides` tables | Done |
| Contact resolver in dispatch layer (sender lookup + message enrichment) | Done |
| Participant extraction from email headers (To/CC → metadata.participants) | Done |
| Contact management skills (`contact.create`, `contact.link-identity`, `contact.unlink-identity`, `contact.set-role`, `contact.grant-permission`, `contact.revoke-permission`, `contact.lookup`, `contact.list`, `contact.merge`) | Done |
| Bus event types: `contact.resolved`, `contact.unknown` | Done |
| Role defaults config (`config/role-defaults.yaml`) | Done |
| Permissions registry config (`config/permissions.yaml`) | Done |
| Unknown sender policy config and enforcement | Done |
| Authorization check in Coordinator context assembly (role → overrides → trust) | Done |
| Audit logging for identity resolution decisions | Done |
| Audit logging for authorization decisions (allow/deny/escalate) | Not Done |
| Integration tests: proactive identity establishment | Not Done |
| Integration tests: reactive identity establishment (unknown sender flow) | Not Done |
| Integration tests: external source enrichment (CRM/calendar → contact) | Not Done |
| Integration tests: authorization check (role defaults + overrides + trust) | Partial — three-layer logic unit-tested in `authorization.test.ts`; end-to-end integration test not covered |
| Smart auto-promotion for provisional contacts — outbound email signals (`email-send`, `email-reply`) and calendar signals promote unverified provisional contacts to verified status | Done |
| Case-insensitive email normalization — `contact-lookup` by email and `contact-merge` for delegated specialists tolerate case differences | Done |

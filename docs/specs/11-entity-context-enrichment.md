# 11 — Entity Context Enrichment

**Date:** 2026-04-02
**Status:** Draft

## Overview

Skills and agents that operate on entities (people, organizations, offices, events) need rich context: who is this entity, what resources do they have, what are their preferences? Today each skill assembles this context independently — or worse, the LLM guesses (e.g., fabricating calendar IDs). This spec defines entity context enrichment as a **platform-level concern**: the system assembles everything it knows about an entity and hands it to skills/agents as a single structured payload.

### Motivating Examples

| Request | Entities | Context needed |
|---|---|---|
| "What's on my calendar?" | Caller (CEO) | Connected calendars |
| "What's on your calendar?" | Agent (Curia) | Curia's connected calendars |
| "What's on Jenna's calendar tomorrow?" | Jenna | Calendars, timezone, scheduling preferences |
| "Schedule a meeting for me, Jenna, and Greg" | CEO, Jenna, Greg | All calendars, timezones, scheduling preferences, faith (for religious observances) |
| "What's Competitor A's battlecard?" | Competitor A (org) | Known documents, URLs — or nothing (LLM searches) |
| "Crawl my inbox" vs. "crawl your inbox" | CEO vs. Curia | Connected email accounts |
| "What's my Aeroplan number?" | CEO | Stored fact |
| "What's the expense policy for Dreamforce?" | Dreamforce (event) | Known facts, related docs |
| "What's HQ's address?" | HQ (office) | Location facts |

Every example follows the same shape:
1. **Subject resolution** — who/what are we talking about?
2. **Context enrichment** — what does the system know about them?
3. **Action** — skill operates with full context; LLM fills gaps

---

## Design Principles

1. **Enrichment is the primary value, not a fallback.** Even when structured resources (calendars, email accounts) resolve cleanly, the surrounding context (timezone, preferences, relationships) makes skills dramatically more effective.

2. **Context is a hint, not a gate.** Missing resources don't cause hard failures. The enriched context tells the LLM what's available; the LLM reasons about how to handle gaps (e.g., searching a shared drive for a document that isn't indexed).

3. **The platform assembles context; skills consume it.** Skills shouldn't need to call five tools to piece together entity information. One call, structured output.

4. **Entities are KG nodes, not just contacts.** People, organizations, offices, events, projects — all are nodes in the knowledge graph. Contacts are a specialized index over person nodes, not the entity model itself.

5. **Subject resolution is the LLM's job.** The LLM is good at understanding "my", "your", "Jenna's", "Competitor A's." The system provides tools to map those references to entity IDs. The entity-context system takes IDs as input, not natural language.

---

## Entity Model

### Relationship to Existing Systems

The knowledge graph ([spec 01](01-memory-system.md)) already stores entities as `kg_nodes` with types: `person`, `organization`, `project`, `decision`, `event`, `concept`, `fact`. The contact system ([spec 09](09-contacts-and-identity.md)) is a thin index over `person` nodes for dispatch-time lookups.

Entity context enrichment builds on both:
- The **KG** is the source of truth for facts, relationships, and preferences
- **Contacts** provide the identity resolution layer (channel identities, roles, verification)
- **Connected accounts** (calendars, email, integrations) link entities to external services
- The **entity-context system** assembles all of the above into a single payload

### What is an Entity?

An entity is any KG node that skills might operate on. The KG already supports open-ended node types. For entity-context purposes, the important distinction is:

| Category | KG node types | Has connected accounts? | Has contact record? |
|---|---|---|---|
| People | `person` | Yes (calendars, email, integrations) | Yes (contacts table) |
| The agent itself | `person` (with `is_agent: true` flag) | Yes | Yes (seeded contact) |
| Organizations | `organization` | No (today) | No |
| Places | `place` | No | No |
| Events | `event` | No | No |
| Projects | `project` | No | No |

The entity-context system works with all KG node types. For entity types without connected accounts, the context payload contains only KG facts and relationships — which may be exactly what the skill needs, or may signal to the LLM that it needs to search elsewhere.

### Agent Self-Identity

The agent (Curia) is an entity with a seeded contact record, just like any other person. This ensures "your calendar" resolves the same way as "Jenna's calendar."

**At bootstrap:**
1. Create (or verify) a KG `person` node for the agent with `properties.is_agent: true`
2. Create (or verify) a `contacts` record with `kg_node_id` pointing to that node
3. Register the agent's connected accounts (calendar, email) against this contact
4. Inject the agent's `contactId` into the coordinator's system prompt (alongside `current_date`, `timezone`)

The coordinator's system prompt includes:
```
Your contact ID is ${agent_contact_id}. When someone refers to "you" or "your",
use this contact ID for entity-context lookups.
```

---

## Entity Context Payload

When a skill or agent needs context about an entity, the system returns a structured payload:

```typescript
interface EntityContext {
  /** The KG node ID for this entity */
  entityId: string;

  /** KG node type: 'person', 'organization', 'event', etc. */
  entityType: string;

  /** Human-readable label from the KG node */
  label: string;

  /** Contact record (only for person entities with a contact record) */
  contact: {
    contactId: string;
    displayName: string;
    role: string | null;
  } | null;

  /** Known facts from the KG, grouped by category.
   *  Facts include confidence and freshness metadata so the consumer
   *  can weigh how much to trust them. */
  facts: EntityFact[];

  /** Connected accounts: calendars, email, integrations.
   *  These are structured resources with API-level identifiers. */
  connectedAccounts: ConnectedAccount[];

  /** Related entities (first-degree KG edges).
   *  Useful for understanding relationships: "Jenna works at Acme",
   *  "Dreamforce is hosted by Salesforce", etc. */
  relationships: EntityRelationship[];
}

interface EntityFact {
  /** Fact label, e.g. "timezone", "Aeroplan number", "scheduling preference" */
  label: string;
  /** Fact value — a string, number, or structured object */
  value: unknown;
  /** Category for grouping — freeform string, convention-driven.
   *  Common values: 'preference', 'identifier', 'location', 'biographical',
   *  'scheduling', 'faith', 'travel', 'financial'. Not an enum — new
   *  categories emerge naturally as the KG grows. */
  category: string;
  /** Confidence score (0-1) from the KG */
  confidence: number;
  /** When this fact was last confirmed */
  lastConfirmedAt: string;
}

interface ConnectedAccount {
  /** Account type: 'calendar', 'email', 'crm', etc. */
  type: string;
  /** Human-readable label, e.g. "Work calendar", "Personal Gmail" */
  label: string;
  /** Service-specific identifier (Nylas calendar ID, email address, etc.) */
  serviceId: string;
  /** Whether this is the primary account of its type for this entity */
  isPrimary: boolean;
  /** Whether the account is read-only */
  readOnly: boolean;
  /** Additional metadata (timezone for calendars, etc.) */
  metadata: Record<string, unknown>;
}

interface EntityRelationship {
  /** Relationship type: 'works_at', 'attends', 'hosted_by', etc. */
  type: string;
  /** Direction: 'outbound' (this entity → target) or 'inbound' (source → this entity) */
  direction: 'outbound' | 'inbound';
  /** The related entity's KG node ID */
  relatedEntityId: string;
  /** The related entity's label */
  relatedEntityLabel: string;
  /** The related entity's KG node type */
  relatedEntityType: string;
}
```

### What's Not in the Payload

- **Raw KG node properties** — the payload exposes curated facts, not the full JSONB blob. This keeps the payload readable for LLMs and avoids leaking internal schema details.
- **Authorization data** — permissions and auth overrides are a dispatch-layer concern, not a skill-layer concern. Skills don't need to know what Jenna is *allowed* to do; they need to know what she *has*.
- **Message history** — working memory and conversation context are handled by the agent runtime, not entity context.
- **Embeddings** — vector representations are internal to the KG search layer.

---

## Entity Context Assembly

### The `entity-context` Skill

A new skill that assembles the full context payload for one or more entities. Available to all skills as a platform capability.

**Manifest:**
```json
{
  "name": "entity-context",
  "description": "Assemble rich context about one or more entities (people, orgs, events, etc.). Returns known facts, connected accounts, preferences, relationships, and other contextual information. Omit entityIds to get context for the caller.",
  "inputs": {
    "entityIds": "string[]? (KG node IDs or contact IDs — omit for caller's context)",
    "contactIds": "string[]? (convenience alias — resolved to KG node IDs via the contacts table)",
    "includeRelationships": "boolean? (default true — set false to reduce payload size)"
  },
  "outputs": {
    "entities": "EntityContext[]",
    "unresolved": "string[] (IDs that couldn't be found)"
  }
}
```

**Resolution priority for each ID:**
1. If the ID matches a `contacts.id` → look up `kg_node_id` from the contact, then assemble from the KG node
2. If the ID matches a `kg_nodes.id` directly → assemble from the KG node
3. Special values: `"caller"` → resolve to `ctx.caller.contactId`, `"agent"` → resolve to the agent's contactId
4. If no match → include in the `unresolved` array (not a hard error)

### Assembly Pipeline

For each resolved entity:

```
KG node lookup
    │
    ├─→ Extract facts (kg_nodes where type='fact', linked via kg_edges)
    │     Group by category, include confidence + freshness
    │
    ├─→ Contact record lookup (contacts table, via kg_node_id)
    │     Include displayName, role
    │
    ├─→ Connected accounts lookup
    │     contact_calendars (today)
    │     contact_email_accounts (future)
    │     contact_integrations (future)
    │
    ├─→ First-degree relationships (kg_edges, depth=1)
    │     Include related entity label + type
    │
    └─→ Compose EntityContext payload
```

The pipeline is a database read path — no LLM involvement, no external API calls. It should complete in single-digit milliseconds for typical entities.

### Caching

Entity context changes infrequently compared to how often it's queried. A simple TTL cache (keyed by entity ID, 5-minute TTL) avoids redundant DB queries when multiple skills operate on the same entity in a single conversation. Cache invalidation on contact/KG mutations is straightforward since those writes go through `ContactService` and `EntityMemory`, which can clear the cache.

---

## Skill Convention: Working with Entities

### The Pattern

Skills that operate on entities follow a consistent convention:

1. **Accept entity references as input** — `contacts?: string[]` for person-oriented skills, or `entityIds?: string[]` for general-purpose skills. Default to the caller when omitted.
2. **Call `entity-context` for enrichment** — get the full context payload before executing domain logic.
3. **Use the context** — extract what's needed (calendar IDs, timezone, preferences, etc.) from the structured payload.
4. **Handle gaps gracefully** — if the context doesn't have what's needed, return a clear message or suggest next steps. Don't fail silently.

### Example: Calendar List Events (after adoption)

```typescript
async execute(ctx: SkillContext): Promise<SkillResult> {
  // 1. Resolve who we're looking up events for
  const contacts = ctx.input.contacts as string[] | undefined;
  const entityIds = contacts ?? [ctx.caller?.contactId ?? 'caller'];

  // 2. Get enriched context
  const contextResult = await ctx.invoke('entity-context', { contactIds: entityIds });
  if (!contextResult.success) return contextResult;
  const entities = contextResult.data.entities as EntityContext[];

  // 3. Extract calendar IDs from connected accounts
  const calendarIds = entities.flatMap(e =>
    e.connectedAccounts
      .filter(a => a.type === 'calendar')
      .map(a => a.serviceId)
  );

  if (calendarIds.length === 0) {
    return { success: false, error: 'No calendars found for the specified contacts' };
  }

  // 4. Also extract timezone preferences for the response
  const timezones = entities.map(e => ({
    name: e.label,
    timezone: e.facts.find(f => f.label === 'timezone')?.value ?? 'unknown',
  }));

  // 5. Fetch events (same as current implementation)
  // ... but now the skill also has timezone info for formatting
}
```

### Example: Calendar Create Event (after adoption)

```typescript
// "Schedule a meeting for me, Jenna, and Greg at a time that works for everyone"

// 1. LLM resolves names via contact-lookup, then calls:
//    calendar-create-event { contacts: ["primary-user", "jenna-id", "greg-id"], ... }

// 2. Handler gets entity-context for all three
//    - CEO: 2 calendars, timezone ET, prefers mornings
//    - Jenna: 1 calendar, timezone PT, observes Shabbat, prefers afternoons
//    - Greg: 1 calendar, timezone CT, no preferences

// 3. Handler uses calendar IDs to check free/busy
// 4. Handler uses preferences + faith to filter candidate times
// 5. Creates event on CEO's primary calendar, Jenna and Greg as attendees
```

### Example: Non-Calendar Skill (knowledge lookup)

```typescript
// "What's my Aeroplan number?"

// 1. entity-context for caller
//    - facts: [{ label: "Aeroplan number", value: "ABC123", category: "identifier" }]

// 2. Skill returns the fact directly

// "What's Competitor A's battlecard?"

// 1. entity-context for Competitor A
//    - facts: [{ label: "industry", value: "SaaS" }, ...]
//    - connectedAccounts: []
//    - No battlecard fact found

// 2. LLM sees no battlecard in context → reasons: "This is probably a document.
//    Let me search the shared drive." → invokes web-fetch or document-search skill
```

---

## Skill-to-Skill Invocation

The pattern above assumes skills can invoke other skills (e.g., a calendar skill invoking `entity-context`). Today, skills can't do this — they return a result and the agent runtime decides the next step.

Two options:

### Option A: LLM orchestrates (no skill-to-skill calls)

The LLM calls `entity-context` first, then passes the results into the domain skill as additional input. This is the simplest approach and works with the current architecture.

```
LLM: "I need Jenna's calendar context"
  → calls entity-context { contactIds: ["jenna-id"] }
  ← returns EntityContext payload

LLM: "Now I can list her events"
  → calls calendar-list-events { calendarIds: ["cal-from-context"], timeMin: ..., ... }
```

**Pros:** No architecture changes. The LLM already orchestrates multi-step tool use.
**Cons:** Extra round-trip. LLM must extract calendar IDs from the context and pass them — reintroducing the "LLM picks the wrong ID" risk.

### Option B: Execution layer pre-enrichment

The execution layer automatically calls `entity-context` before invoking the handler, based on a manifest declaration. The handler receives the enriched context as part of `SkillContext`.

```json
{
  "name": "calendar-list-events",
  "entity_enrichment": {
    "param": "contacts",
    "default": "caller"
  }
}
```

The execution layer sees this declaration, resolves the entity context, and injects it into `ctx.entityContext` before the handler runs. The handler never calls entity-context directly.

**Pros:** Zero extra LLM round-trips. No risk of the LLM mishandling IDs. Clean handler code.
**Cons:** Framework complexity. Couples entity-context into the execution layer. Pre-enrichment may fetch data the handler doesn't need.

### Recommendation: Option B

Option A reintroduces the exact problem that motivated this spec — the LLM extracting IDs from one tool's output and passing them to another. Option B makes enrichment deterministic and invisible to the LLM. The LLM's only job is resolving natural language to entity IDs; everything after that is framework machinery.

The manifest declaration keeps it opt-in: skills that don't need entity context don't declare `entity_enrichment` and pay no cost. Skills that do declare it get the context automatically.

### Execution Layer Changes

When a skill declares `entity_enrichment`:

1. Extract the entity IDs from the skill's input (the parameter named in `entity_enrichment.param`)
2. If no IDs provided, use the default (`"caller"` → `ctx.caller.contactId`, `"agent"` → agent's contactId)
3. Run the entity-context assembly pipeline (same logic as the `entity-context` skill, but called directly — no bus round-trip)
4. Attach the result to `ctx.entityContext: EntityContext[]`
5. Invoke the handler as usual

The `entity-context` skill itself is still available for cases where the LLM needs to inspect entity context interactively (e.g., "tell me what you know about Jenna").

---

## Connected Accounts Registry

### Current State

Today, `contact_calendars` is the only connected-accounts table. It maps contacts to Nylas calendar IDs.

### Future State

As more integrations are added (email accounts, CRM connections, file storage), each gets its own table following the same pattern:

```
contact_calendars      — Nylas calendar grants
contact_email_accounts — Nylas email grants (future)
contact_integrations   — Generic integrations (future)
```

The entity-context assembly pipeline queries all connected-account tables for the entity and includes them in the `connectedAccounts` array. Each table has its own schema (calendars have timezone; email accounts have signatures; integrations have provider-specific metadata), but the entity-context payload normalizes them into a common `ConnectedAccount` shape.

### Proactive Account Discovery

When the assembly pipeline finds an entity with no connected accounts of a given type, it should proactively check available providers. For example, if a contact has no registered calendars but the system has a Nylas grant that covers their email domain, the pipeline checks Nylas for available calendars and suggests linking them. This surfaces as a `discoveredAccounts` field on the payload — not auto-linked (that requires explicit action), but visible so the LLM can prompt the user: "I found Jenna's calendar on Google — would you like me to connect it?"

### Why Not a Single `entity_resources` Table?

Calendars, email accounts, and CRM connections have fundamentally different schemas, credentials, and lifecycle management. A single polymorphic table would require JSONB for everything, lose type safety, and make migrations painful. Separate tables with a shared query pattern (the entity-context assembly pipeline) gives us type safety per resource type with a unified read path.

---

## Migration Path

### Phase 1: Foundation (this spec)

1. **Agent self-identity** — seed Curia's contact record with `is_agent` flag, inject contactId into system prompt
2. **Entity-context assembly function** — shared TypeScript module that assembles the `EntityContext` payload from KG + contacts + connected accounts
3. **`entity-context` skill** — wraps the assembly function as a callable skill for LLM-driven lookups
4. **Execution layer `entity_enrichment`** — manifest declaration triggers automatic pre-enrichment

### Phase 2: Calendar Skill Adoption

5. **Calendar skills adopt the convention** — `calendar-list-events`, `calendar-create-event`, `calendar-find-free-time`, `calendar-check-conflicts` declare `entity_enrichment` in their manifests and receive `ctx.entityContext` with resolved calendar IDs, timezones, and preferences
6. **Remove `calendarId` from skill inputs** — calendar skills no longer accept raw calendar IDs; the entity-context system handles resolution. `calendarId` can remain as a hidden escape hatch but should not appear in the LLM's tool definition.
7. **Update skill descriptions** — remove all guidance about calendar ID lookup; the LLM only thinks in terms of people

### Phase 3: Broader Adoption

8. **Knowledge skills** — `knowledge-travel-preferences`, `knowledge-loyalty-programs`, etc. adopt entity-context instead of hard-coding caller assumptions
9. **Email skills** — when email accounts are added to connected accounts, `email-send`/`email-reply` use entity-context to resolve sender accounts
10. **`entity-lookup` skill** — a new broad-based search skill for resolving any KG entity (orgs, events, places, projects) to entity IDs. Separate from `contact-lookup`, which stays focused on people — contact resolution is identity-sensitive and mistakes there have real consequences (wrong person's calendar, wrong email). `entity-lookup` is more exploratory: fuzzy matching is acceptable, and results are used for context enrichment rather than identity verification.

---

## Integration with Existing Specs

| Spec | Integration Point |
|---|---|
| **01 — Memory System** | Entity context reads from the KG (nodes, edges, facts). The assembly pipeline is a read-only query pattern — it does not write to the KG. Fact categories in the payload map to the KG's `fact` node type. |
| **02 — Agent System** | Agent self-identity (Curia's contact record) is seeded at bootstrap. The agent's contactId is injected into the coordinator's system prompt. |
| **03 — Skills & Execution** | `entity_enrichment` manifest declaration is a new feature of the execution layer. `ctx.entityContext` is a new field on `SkillContext`. The `entity-context` skill is a new local skill. |
| **09 — Contacts & Identity** | Contacts are the identity resolution layer for person entities. Entity-context reads from contacts but does not modify them. The agent's seeded contact record is a new bootstrap step. |

---

## Security Considerations

- **Entity context is read-only.** The assembly pipeline queries the KG, contacts, and connected accounts but never writes. All mutations go through their respective services (ContactService, EntityMemory).
- **No cross-entity leakage.** The entity-context payload includes only the requested entities. A skill asking for Jenna's context does not receive the CEO's connected accounts.
- **Cached context respects mutations.** The TTL cache is invalidated on contact/KG writes. Stale context is a convenience issue (slightly outdated preferences), not a security issue (wrong person's data).
- **Agent self-identity is seeded, not self-created.** Curia's contact record is created during bootstrap by the orchestrator, not by the agent itself. The agent cannot modify its own identity.
- **LLM sees entity IDs, not raw KG internals.** The payload exposes curated facts with labels, not raw JSONB properties or internal node IDs beyond what's needed for skill invocation.

---

## Resolved Design Decisions

1. **Fact categorization: freeform with convention.** The `category` field is a plain string, not an enum. Common values (`preference`, `identifier`, `location`, `scheduling`, `faith`, etc.) emerge by convention. No schema enforcement — new categories appear naturally as the KG grows.

2. **Connected account discovery: proactive.** When the pipeline finds an entity with no connected accounts, it checks available providers (e.g., Nylas) and surfaces discoverable accounts in the payload. These are not auto-linked — the LLM prompts the user to confirm.

3. **Entity search: separate `entity-lookup` skill.** `contact-lookup` stays focused on people — identity resolution is high-stakes and mistakes have real consequences. A new `entity-lookup` skill handles broad KG search (orgs, events, places, projects) where fuzzy matching is acceptable.

4. **Batch performance: deferred.** Multi-entity lookups will use sequential queries initially. Batch optimization (single DB round-trip) can be added when performance data shows it's needed.

5. **Partial enrichment: deferred.** All skills receive the full context payload. <!-- TODO: add partial enrichment (e.g., "only connected accounts, skip relationships") if profiling shows the full payload is wasteful for simple skills -->

---

## Implementation Checklist

### Phase 1: Foundation
- [ ] Agent self-identity: KG node + contact record for Curia, bootstrap seeding
- [ ] Agent contactId injection into coordinator system prompt
- [ ] Entity-context assembly module (`src/entity-context/`)
- [ ] Proactive account discovery in the assembly pipeline
- [ ] `entity-context` skill (manifest + handler)
- [ ] `ctx.entityContext` field on `SkillContext`
- [ ] `entity_enrichment` manifest declaration support in execution layer
- [ ] TTL cache for entity context payloads
- [ ] Cache invalidation on contact/KG mutations
- [ ] Unit tests: entity-context assembly for person, org, event entities
- [ ] Unit tests: execution layer pre-enrichment
- [ ] Unit tests: cache behavior (hit, miss, invalidation)

### Phase 2: Calendar adoption
- [ ] Calendar skills adoption (list-events, create-event, find-free-time, check-conflicts)
- [ ] Remove `calendarId` from LLM-visible tool definitions
- [ ] Integration test: end-to-end "What's on Jenna's calendar?" flow

### Phase 3: Broader adoption
- [ ] `entity-lookup` skill for broad KG entity search (orgs, events, places)
- [ ] Knowledge skills adoption (travel-preferences, loyalty-programs, etc.)
- [ ] Email skills adoption (when email connected accounts are added)

---

## Implementation Status

### Phase 1: Foundation

| Item | Status |
|---|---|
| Agent self-identity: KG node + contact record, bootstrap seeding | Done |
| Agent contactId injection into coordinator system prompt | Done |
| Entity-context assembly module (`src/entity-context/`) | Done |
| `entity-context` skill (manifest + handler) | Done |
| `ctx.entityContext` field on `SkillContext` | Done |
| `entity_enrichment` manifest declaration support in execution layer | Done |
| TTL cache for entity context payloads | Done |
| Cache invalidation on contact/KG mutations | Done |
| Proactive account discovery (`discoveredAccounts` field) | Not done |
| Unit tests: entity-context assembly | Done |
| Unit tests: execution layer pre-enrichment | Done |
| Unit tests: cache behavior (hit, miss, invalidation) | Done |

### Phase 2: Calendar adoption

| Item | Status |
|---|---|
| Calendar skills declare `entity_enrichment` in their manifests | Not done |
| Remove `calendarId` from LLM-visible tool definitions | Not done |
| Integration test: end-to-end "What's on Jenna's calendar?" flow | Not done |

### Phase 3: Broader adoption

| Item | Status |
|---|---|
| `entity-lookup` skill for broad KG entity search (orgs, events, places) | Not done |
| Knowledge skills adoption (travel-preferences, loyalty-programs, etc.) | Not done |
| Email skills adoption (when email connected accounts are added) | Not done |

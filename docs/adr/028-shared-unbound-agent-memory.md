# ADR-028: Shared, unbound agent memory (no per-agent scope isolation)

Date: 2026-07-14
Status: Accepted

## Context

Agent YAML configs carried an optional `memory.scopes` field, and several documents (the agent dev guide, the agent-system spec, the architecture overview) described it as an enforced isolation boundary — "an agent only sees entities within its declared scopes." Issue #521 was filed to make that guarantee real: thread the declared scopes to the runtime and filter knowledge-graph reads/writes by scope.

Investigation (issue #521) found the field was inert end-to-end: parsed into a typed config field, copied into the registry manifest, and rendered as a console column, but never threaded to `AgentRuntime`, `ExecutionLayer`, `ToolContext`, `EntityMemory`, or `KnowledgeGraphStore`. Every agent shared one un-scoped knowledge graph; `semanticSearch()` filtered only on `type` and `sensitivity`; `kg_nodes` had no `scope` column. Only 3 of 8 first-party agents declared a scope at all.

Before building enforcement, we reconsidered whether per-agent memory isolation is the right model. Options considered:

1. **Enforce fully-scoped isolation** — add a `scope` column, thread scopes to the runtime, hard-filter reads/writes by the agent's declared scope.
2. **Read-broad / write-narrow** — reads stay unbound; writes get tagged with the agent's scope as provenance; optionally bias ranking toward in-scope memory.
3. **Remove the field** — delete it, document the real model (shared, unbound), and reintroduce scoping only when a concrete consumer (an untrusted agent) exists.

## Decision

**Remove `memory.scopes` entirely and adopt an explicit shared-memory model.**

> Curia memory (the knowledge graph and the OKF document workspace) is a single shared substrate. Any enabled agent may read and write across it. Access is governed by **capability gating** (whether the agent is granted the memory surfaces at all), **data sensitivity tiers** (the `max_sensitivity` ceiling on `memory-query`), and **source/provenance attribution** on writes — not by per-agent identity scopes.

Rationale for rejecting enforcement (options 1 and 2):

- **No consumer.** All 8 agents are first-party, trusted, in-repo specialists. There is no untrusted, sandboxed, or externally-authored agent, and no third-party load path. The exfiltration threat model that motivated scope isolation has no current subject.
- **Wrong primitive for the store.** The knowledge graph is entity-centric — facts hang off entities, not agents. Filtering reads by agent scope would fragment a single entity's facts across scopes, fighting the "one shared graph any agent enriches" premise of the memory spec (01). The agents that declared scopes (`ceo-inbox`, `research-analyst`, `meeting-debrief`) are precisely the cross-cutting synthesizers whose value is reading broadly.
- **Redundant with existing mechanisms.** `semanticSearch()` already ranks by query relevance (pgvector cosine), so a scope hint adds little for relevance; `source` already records write provenance; sensitivity tiers already gate data classification; the OKF workspace already scopes focus by path convention. A scope construct would duplicate machinery that already exists.
- **Honesty.** Keeping an inert field that docs describe as a security boundary is worse than not having it — it implies a guarantee the system never delivered.

## Consequences

- **Docs now match reality.** Every reference that claimed scope-based isolation (dev guide, specs, architecture diagrams, public docs) is corrected to describe the shared model. A notably false public claim — that "a compromised specialist can only affect the narrow scope it was given" — is removed.
- **Breaking change to the agent-config schema.** `memory.scopes` is removed from `schemas/agent-config.schema.json`, which has top-level `additionalProperties: false` and is enforced at boot by `src/startup/validator.ts` (a violation is fatal — `process.exit(1)`). Removing the field means any remaining `memory.scopes` declaration causes a hard boot failure (the `memory:` block held nothing but `scopes`). The runtime behavior of memory is unchanged, but this is not a no-op deploy: **every agent config that still declares `memory.scopes` must be cleaned in the same rollout.** The three core agents are updated here; instance-layer agents (`curia-deploy/custom/agents/`) that declare it must be cleaned and deployed before an instance adopts a core build carrying this schema, or the container crash-loops. Called out in the CHANGELOG per the public-API-surface rule.
- **The console "Memory scopes" column is removed** (it displayed a field with no meaning).
- **Reopen trigger.** If Curia ever gains an untrusted or externally-authored agent tier, per-agent memory isolation becomes worth building — as read-filtering keyed off a real trust boundary, informed by the existing sensitivity + provenance + capability mechanisms. This ADR should be revisited (and likely superseded) at that point, not before.

# Remove `memory.scopes` — design note (#521)

Status: implemented. Durable record is [ADR-028](../adr/028-shared-unbound-agent-memory.md).

## Problem

Issue #521 asked to enforce the `memory.scopes` agent-config field at runtime. Investigation showed the field was inert end-to-end (parsed → registry manifest → console column, but never threaded to the runtime or the knowledge-graph store), and that enforcement is unmotivated: all 8 agents are first-party and trusted, and a hard read-filter is the wrong primitive for an entity-centric shared graph. Docs meanwhile described it as an enforced isolation boundary the runtime never honored.

## Decision

Full delete over enforcement or a soft hint. Memory is a single shared substrate; access is governed by capability gating + sensitivity tiers + source attribution, not per-agent scopes. Reintroduce only when an untrusted agent tier exists. Full rationale and reopen-trigger in ADR-028.

## Change surface

- **Code** — removed the field from the 3 declaring agent YAMLs (`ceo-inbox`, `research-analyst`, `meeting-debrief`; patch-bumped), `schemas/agent-config.schema.json`, the loader interface (`src/agents/loader.ts`), `ManifestMetadata` (`src/registry/types.ts`), the registry mapping in `src/index.ts`, and the console "Memory scopes" column (`apps/console/src/pages/RegistrySettings.tsx`). No migration (there was never a `scope` column).
- **Docs (this repo)** — `docs/dev/adding-an-agent.md`, `docs/specs/02-agent-system.md`, `docs/specs/06-audit-and-security.md`, `docs/adr/003`, root `CLAUDE.md`, and the two `docs/assets/*.excalidraw` diagram sources. New ADR-028 + this note.
- **Docs (curia-docs public site)** — separate PR: `references/agent-manifest-schema.mdx`, `agents/multi-agent-architecture.mdx` (removed a false security claim), `agents/building-custom-agents.mdx`, `agents/how-agents-work.mdx`, `core-concepts/architecture.mdx`.

## Follow-up

The rendered diagram PNGs (`docs/assets/architecture-{detailed,overview}.png`) still show the old "Memory Scopes" / "Isolated Memory" labels; the `.excalidraw` sources are corrected but the exports need regenerating with Excalidraw tooling. Tracked as a follow-up, not blocking.

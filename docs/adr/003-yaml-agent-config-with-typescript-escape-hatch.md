# ADR-003: YAML agent config with TypeScript escape hatch

Date: 2026-02-20
Status: Accepted

## Context

Agent definitions need to capture: identity (name, description, model), system prompt, pinned skills, memory scopes, schedule, and error budget. These are primarily static configuration that doesn't change per-request.

Options considered:
1. **TypeScript only** — agents defined entirely in code; maximum flexibility, but no declarative overview
2. **YAML only** — fully declarative; inspectable without running code, but no escape hatch for custom logic
3. **YAML with optional TypeScript handler** — declarative baseline with a `handler:` field pointing to a `.ts` file for agents that need custom dispatch logic

## Decision

Agent definitions are YAML files (`agents/*.yaml`) with an optional `handler:` field pointing to a TypeScript module.

The YAML layer captures what's universally declarative: identity, model selection, system prompt, pinned skills, memory scopes, schedule, and error budget. This can be read and understood without running the system.

The TypeScript escape hatch (`handler: ./coordinator.handler.ts`) is available for agents with non-trivial routing logic (e.g., the Coordinator, which dynamically selects agents based on message content). Standard specialist agents need no handler — the runtime's default execution path is sufficient.

## Consequences

- Agents can be inspected, audited, and diffed as plain text without code execution.
- New agents for standard use cases require no TypeScript — just a YAML file.
- Custom agents (like the Coordinator) can express arbitrary dispatch logic in the handler without polluting the base runtime.
- The YAML schema is a public API surface — changes are breaking and must be called out in the changelog even in the `0.x` range.
- Schema validation runs at startup; malformed agent files crash early rather than failing silently at runtime.

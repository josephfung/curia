# ADR-002: Message bus over direct calls

Date: 2026-02-05
Status: Accepted

## Context

The system has five distinct layers (Channel, Dispatch, Agent, Execution, System) that need to communicate. The two obvious implementation patterns were:

1. **Direct calls** — each layer imports and calls the next layer's functions directly
2. **Message bus** — all communication flows through a central typed event bus backed by Postgres

Direct calls are simpler to implement and debug. However, Curia has strict requirements around security boundaries, auditability, and restart safety that pull strongly toward the bus pattern.

## Decision

All inter-layer communication flows through a central in-process message bus backed by Postgres for persistence.

Key aspects of the decision:
- **Typed event registry** — all event types are defined as a TypeScript discriminated union. No `any` payloads, no stringly-typed event names without compile-time checking.
- **Hard security boundaries** — the bus validates publisher authorization at registration time. A layer registered as `"channel"` cannot publish `skill.invoke`. This is architectural enforcement, not policy.
- **Write-ahead audit logging** — the audit logger writes events to Postgres *before* delivering to other subscribers. This gives at-least-once delivery guarantees even across restarts.
- **System layer** — trusted infrastructure (audit logger, memory engine, scheduler) registers with full pub/sub access. All other layers have a restrictive allowlist.

The alternative — direct calls with post-hoc audit logging — was rejected because it requires all callers to remember to log, makes security boundaries organizational rather than enforced, and doesn't provide restart-safe delivery guarantees.

## Consequences

- Adding a new capability (new event type) requires updating the discriminated union and the permissions map — intentional friction that prevents undocumented side-channels.
- The bus is currently in-process; true distributed messaging (e.g., Redis Streams) would require replacing the bus layer without changing the interfaces.
- Write-ahead audit logging means every event incurs a Postgres write before in-process delivery. This is an intentional latency trade-off for durability.
- Debugging requires reading the audit log rather than stepping through a call stack — observability tooling is more important than in direct-call architectures.

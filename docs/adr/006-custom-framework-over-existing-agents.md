# ADR-006: Build custom framework over adopting existing agent frameworks

Date: 2026-02-05
Status: Accepted

## Context

Building a production AI agent system requires a foundation. The obvious question was whether to adopt an existing open-source agent framework or build a purpose-built one. Four candidates were evaluated:

- **agentsystems** — single maintainer, no code review, thin tests, immature architecture
- **Daemora** — same risk profile as agentsystems
- **ForgeAI** — same risk profile
- **Edict** — same risk profile

All four were assessed as high-risk for production use: they lacked code review processes, had minimal test coverage, and were architected for demo use cases rather than long-running production systems.

The alternative was to build a minimal custom framework ("Curia") purpose-built for a long-running, VPS-hosted executive assistant.

## Decision

Build a custom framework from scratch rather than adopting an existing open-source agent framework.

The custom framework is scoped to exactly what the system needs: a typed message bus, a layered security model, a skill execution layer, and a knowledge graph. It does not try to be general-purpose.

The existing `ceo-deploy` infrastructure (Hetzner VPS, Docker Compose, Caddy) is reused. The Zora dependency is replaced entirely — no data migration, because Zora was an evaluation system, not a production system with accumulated data worth preserving.

## Consequences

- No inherited technical debt or surprise breaking changes from upstream maintainers.
- Every architectural decision is intentional and documented (this ADR directory).
- The maintenance burden falls entirely on this project — there is no upstream community to fix security issues or add capabilities.
- New contributors cannot rely on prior framework knowledge; they must learn Curia's patterns from its docs and code.
- The framework is deliberately minimal — capabilities are added when needed, not speculatively. This keeps the surface area small and the codebase auditable.

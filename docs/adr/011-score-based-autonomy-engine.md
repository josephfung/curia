# ADR-011: Score-based autonomy engine over capability-based permissions

Date: 2026-03-28
Status: Accepted

## Context

The agent system needs a mechanism for the executive to control how autonomously the system acts. Two design approaches were considered:

1. **Capability-based permissions** — a set of boolean flags or allowlists (e.g., "allow: email, calendar; deny: financial"). The executive grants or revokes specific capabilities.

2. **Score-based autonomy** — a single integer (0–100) representing global autonomy level. Skills declare a minimum score required to invoke them (`action_risk`). The executive sets the score; skills gate themselves.

## Decision

Every skill manifest must declare an `action_risk` field indicating the minimum autonomy score at which this skill may run without explicit CEO confirmation.

Use a single score (0–100) with five named bands: none (0–59), low (60–69), medium (70–79), high (80–89), critical (90–100). Each skills `action_risk` can have a numeric value, or a named band as a shortcut.


Score-based was chosen over capability-based because:
- **Cognitive simplicity** — one number is easier to reason about than a permission matrix. The executive can say "I want supervised mode today" rather than managing a list of allowed capabilities.
- **Graceful degradation** — as the score increases, more skills become available without the executive needing to explicitly grant each one. Decreasing the score progressively restricts capability.
- **Natural language alignment** — "set autonomy to 60" maps cleanly to a Coordinator instruction. A permission matrix would require natural language parsing to determine which capabilities to toggle.
- **Consistent enforcement** — the gate is in the execution layer, not the agent layer. Skills cannot bypass it, regardless of what the LLM requests.

The five band names  are human-readable aliases for score ranges, documented in `docs/specs/14-autonomy-engine.md`.

## Consequences

- The executive manages autonomy through a single slider, not a permission matrix. This trades expressiveness for simplicity.
- Skills must declare their `action_risk` at manifest load time — it cannot be dynamic. This is a deliberate constraint that makes the authorization model auditable.
- A skill that needs to perform actions across multiple risk levels must be split into multiple skills (one per risk tier).
- Phase 2 (per-skill and per-contact overrides) can add more granularity without changing the core score-based model.
- The `action_risk` field is part of the skill manifest public API — renaming it or changing its semantics is a breaking change.

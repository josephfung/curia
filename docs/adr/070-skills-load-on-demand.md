# ADR-070: Skills load on demand

Date: 2026-11-26
Status: Accepted

## Context

Pinning a skill today expands its SKILL.md body and every member tool into the
agent's fixed context on every call (ADR-031 / ADR-032 Tier 0). On the
coordinator, tool definitions are ~87% of that fixed context (~21,800 tokens).
Anthropic's Agent Skills model keeps only the skill description always in
context and loads the body with its tools on activation; that cuts context and
improves tool selection on large tool sets.

#2764 adopts that model. A temporary per-agent `skill_loading: eager | on_demand`
switch (default `eager`) lets the mechanism land and A/B without flipping
production in the same PR. The switch is removed when every agent moves to
on-demand (#2764 PR 3).

Alternatives considered:

- Keep eager pins and rely on prompt trimming — does not address tool-definition
  cost, which dominates.
- Always-on tool pins for every tool — loses the "rules travel with tools"
  property and recreates the same budget problem.
- Anthropic's host-side tool-search — Couples Curia to one provider's protocol;
  we already own activation via `skill-activate`.

## Decision

1. **Two pin kinds only.** A skill pin lists the skill (name + description) and
   loads body + member tools on activation. A tool pin always loads that one
   tool. There is no eager skill mode once the migration switch is gone.
2. **Activation is append-only.** The SKILL.md body arrives in the
   `skill-activate` tool result, not as a system message spliced before
   history, so the prompt prefix (and the provider cache) holds. New tool
   definitions append in a stable order.
3. **Code pre-activates through one entry point** (`preActivateSkills`) for
   wakes, conversation carry, jobs, Bullpen, onboarding, digest paths, and
   later trigger-based skills (#2765). Every activation writes `skill.activated`
   with a `by` path.
4. **Budget (ADR-046).** Always-on prompt = YAML + skill list. Local tool
   definitions = tool pins (+ `skill-activate` / `tool-registry` where present).
   Activated bodies and their tools are not in the always-on budget.
5. **Migration.** `skill_loading: eager` preserves ADR-031/032 Tier 0 behaviour.
   `on_demand` is the new model. Default remains `eager` until PR 3 flips agents
   and deletes the switch.

This ADR replaces Tier 0 eager skill-body expansion in ADR-031 and ADR-032 for
agents on `on_demand`, and updates ADR-046's budget definition as above.

## Consequences

- Fixed context on the coordinator drops toward ~6k tokens once on-demand is
  on and bundles are split (#2764 PR 3).
- Live turns may pay one activation round (~4 s p50, ~14k uncached tokens once)
  when a skill is first needed; conversation carry and job/wake pre-activation
  avoid repeating that cost.
- `principalReach` must count tools from listed skills, or moving send tools
  into skills would silently cut reach to the principal.
- Scenario and prod checks read `skill.activated` so code pre-activation is
  visible (unlike `called: skill-activate` alone).
- The temporary `skill_loading` field is a migration switch, not a permanent
  mode; leaving it after switch-over would preserve two behaviours indefinitely.

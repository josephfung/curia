# ADR-032: Polymorphic capability pins and MCP servers as skills

Date: 2026-07-21
Status: Accepted

## Context

Phase 2 (#1489, [ADR-031](031-tools-vs-skills-vocabulary.md)) introduced the skill
(bundle) abstraction — `SKILL.md` + nested `tools/` — and shipped three exemplars
(`calendar`, `tasks`, `documents`). The Phase 2 follow-up (#1494) bundles the remaining
~98 flat tools into their natural clusters. Two of the design doc's §10 open questions
([`docs/wip/2026-07-16-tools-skills-architecture-design.md`](../wip/2026-07-16-tools-skills-architecture-design.md))
block that work and must be settled first.

1. **What does a pin reference?** Once tools live inside bundles, an agent that needs
   only *one* low-risk member of a bundle would be forced to pin the whole bundle —
   silently widening its authority. Concrete cases from the current config:
   `scheduler-report` is pinned by 7 agents while `scheduler-create` is pinned by 2; the
   custom `T2125-expense-tracker` agent pins `ceo-inbox-search` + `ceo-inbox-download-attachment`
   but none of the ceo-inbox drafting/archive tools. Forcing a bundle pin on these agents
   violates the §8 invariant — *"an imported skill cannot expand the activating agent's
   authority"* — generalized to any bundle.

2. **Does an MCP server present as a skill?** Design §3 frames an MCP server as a bundle
   subtype and §4 says discovery *"spans tools and skills."* Whether a server projects a
   skill into `SkillRegistry` (unified discovery + single-name pin) or stays tools-only was
   left open. Today agents pin MCP tools individually — the coordinator names ~24
   `google-workspace` tools; the `T2125-expense-tracker` and `essay-editor` custom agents
   ~15 each — which is exactly the flat-atom sprawl bundling exists to remove.

Alternatives considered:

- **Pin-minus-tool exclusion** as the primary mechanism (pin `calendar` but drop
  `calendar-delete-event`). Rejected as the base model: it is subtractive and per-bundle,
  does nothing for an agent that wants a *single* tool from an otherwise-unwanted bundle,
  and complicates bidirectional drift-checking.
- **Keep MCP tools-only; bundle only native tools.** Rejected: it leaves the single largest
  pin-count concentration (MCP tool sprawl) unaddressed and contradicts §4 *"unify by
  runtime shape"* — MCP tools already share the runtime catalog with native tools.

## Decision

### 1. Pins are polymorphic — a pin references a capability, not a container

`pinned_skills` (field name unchanged for now) accepts, uniformly:

- a **skill** (bundle) name → resolves to all member tools + any `SKILL.md` instructions;
- a **tool** name → resolves to exactly that tool (today's singleton behavior);
- (future) an **MCP capability** — a projected MCP skill name, or an individual MCP tool.

It must not matter *how* a capability was added. The skill stays the install / enable /
disable unit (operator lifecycle); the pin stays the per-agent runtime-availability unit
(§6). The two are orthogonal: an operator enables the `ceo-inbox` skill as one feature while
the `T2125-expense-tracker` agent pins only `ceo-inbox-search` and
`ceo-inbox-download-attachment`, gaining nothing else.

This makes pin-minus-tool exclusion unnecessary for the motivating cases. If a genuine
"bundle minus one" need appears later, add it as a subtractive modifier *on* a skill pin —
not as the base model.

### 2. An MCP server projects a skill into `SkillRegistry`

Each configured MCP server (`config/skills.yaml`) surfaces as a skill in the collection
registry — discoverable by name, pinnable by name — while its individual tools continue to
register into the runtime `ToolRegistry` exactly as [ADR-016](016-mcp-sdk-dependency.md)
established. This is the §4 rule applied to lifecycle: **unify by runtime shape** (tools in
`ToolRegistry`), **separate by lifecycle** (the server is its own installable skill).
Per-server `action_risk` still applies to all of that server's tools (no per-tool override),
unchanged from today.

Pinning the projected skill (e.g. `google-workspace`) resolves to that server's live tool
set at pin-resolution time — collapsing the coordinator's ~24 named MCP pins to one.

## Consequences

**Easier:**

- #1494 can bundle the ~98 flat tools with **no agent gaining authority** — the regression
  check *"resolved member-tool set unchanged"* is satisfiable because a narrow consumer pins
  the narrow tool, not the bundle.
- The largest single pin-count reduction in the epic comes for free: MCP tool sprawl
  collapses to per-server skill pins.
- Discovery is uniform — skill search can return "a tool", "a skill", or "an MCP skill"
  without the caller special-casing the capability's origin.

**Harder / accepted:**

- Pin resolution (`resolvePinnedSkills`) must branch on referent kind (skill vs tool vs
  MCP-projected skill) and stay stable when a bundle's membership changes. A test must
  assert that pinning one tool of a bundle does **not** pull in the bundle's other tools.
- An MCP skill projects membership **dynamically** (a server's tool list can change between
  boots), so a pinned MCP skill's resolved set is not statically knowable from the repo — it
  is logged at resolution time for auditability.
- `config/skills.yaml` stays MCP-server-oriented in name while the same servers now also
  appear as skills; ADR-031's "clarify-later" note on that filename is unchanged.

This ADR resolves two of the design doc's §10 open questions (fine-grained pin override;
MCP-as-skill) and is a prerequisite for #1494. [ADR-016](016-mcp-sdk-dependency.md) (MCP
tools in the shared runtime catalog) and [ADR-022](022-skill-agent-registry.md)
(install/enable lifecycle) are unchanged.

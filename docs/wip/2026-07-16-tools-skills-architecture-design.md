# Design: Tools & Skills — capability granularity and Claude-skill import

**Status:** Design exploration (synthesized). No build committed. This is the conceptual
design; a real implementation plan + sequencing would follow if pursued.
**Date:** 2026-07-16
**Related:** open-core / self-host extensibility thesis (curia#1281); existing skill system
(`docs/specs/03-skills-and-execution.md`, `docs/dev/adding-a-skill.md`).

---

## 1. Context — the problem

Curia's "skills" are typed TypeScript handlers + a JSON manifest, capability-gated. That
diverges from the now-standard Anthropic **Agent Skill** format — a Markdown `SKILL.md` +
progressive-disclosure reference files + optional executable scripts — which Claude Code and
Cowork use. We want operators to extend Curia easily, ideally by lifting skills they've already
authored (e.g. Max Tremain's `not-a-lawyer`) with minimal friction. Two forces surfaced along
the way that turn this from "add an importer" into "reshape a core abstraction":

- Curia's "skill" and Anthropic's "skill" are **different things sharing a name**.
- Curia has one first-class granularity (the individual operation) and keeps faking a
  higher, collection-level one (`enable_task_management`, MCP servers).

This doc settles the vocabulary, the granularity model, the registry layering, the runtime
activation model, and the import/trust boundary.

---

## 2. Core reframe — tools vs skills (naming: DECIDED)

The insight that unlocks everything: what Curia calls a "skill" is a **tool** (a typed,
gated capability), and what Anthropic calls a "skill" is a **bundle of instructions + optional
tools**. "tool" was doubly-claimed (lay speech: tool = *calendar*; Messages API + MCP: tool =
*calendar-create-event*). Resolution:

| Level | Name | Is | Unit of |
|---|---|---|---|
| atom | **tool** | `calendar-create-event` | invocation + authorization (`action_risk`, `sensitivity`, `allowed_callers`) |
| collection | **skill** | `calendar`, `task-management`, `not-a-lawyer`, an MCP server | install / enable / pin / discover / activate |

This matches the Messages API + MCP at the atom layer and Anthropic Agent Skills at the
collection layer (the thing being imported), and it makes existing names *finally true*
(`pinned_skills` really pins skills; `SkillRegistry` really holds skills).

**Rename consequences:** Curia's atom-"skill" → **"tool"**; `skill.json` → per-tool `tool.json`;
`SkillHandler`/`SkillContext`/`SkillResult` unchanged in shape but re-scoped as the *tool*
contract. This is a public-API sweep (~111 core tools + custom, `skill_registry` table,
`skillSearch`, `registry-defaults.yaml`, docs) + DB migration + changelog. **Pre-1.0 /
mid-open-core is the cheapest this rename ever gets** — it's the recommended first build because
everything else sits on it.

---

## 3. Granularity — the missing "bundle" abstraction

Curia has ONE first-class granularity (the atom) and fakes the collection three times:

- **MCP server** — install a server (collection) → its tools land individually in the runtime
  catalog. Cluster *lifecycle*, atom *exposure*.
- **`enable_task_management`** (`src/agents/task-management.ts`) — a HARDCODED bundle:
  `TASK_MANAGEMENT_SKILLS` (4 tools) + `TASK_MANAGEMENT_BLOCK` (shared instruction prose) +
  behavior (heartbeat, document workspace), applied as one flag. Tools + the NL instructions to
  use them = **exactly the Anthropic-skill shape.**
- **(Future) imported Claude skills** — would be a third bespoke bundle if not generalized.

Three ad-hoc bundles ⇒ the abstraction is missing. **Add a `skill` (bundle) level; do NOT
replace the tool.** Per-tool gating is load-bearing (`calendar-list` = none, `calendar-create`
= high); collapsing it loses safety granularity. The tool stays the invocation + authorization
unit; the skill becomes the packaging / lifecycle / pinning / discovery unit humans and agents
think in. This **generalizes what MCP already does** (install server → get tools) to native
tools too.

Payoff cascade:
- `pinned_skills: [calendar-*]` → `pinned_skills: [calendar]` (now pinning bundles).
- `enable_task_management: true` → `pinned_skills: [task-management]` — the bespoke flag
  dissolves into the general mechanism (a skill that ships an instruction block).
- The skill IS the container an imported Claude skill lands in ⇒ **"install as collections" and
  "support Claude skills" are the same project.**

Unifying frame: **skill = {tools} + {optional orchestrating instructions} + {optional lifecycle
behavior}**; native-toolset / MCP-server / imported-Claude-skill are subtypes filling different
slots.

---

## 4. Registry layering

Two distinct things are both called "registry"; they answer different questions.

- **Layer 1 — runtime tool catalog** (`SkillRegistry` today → rename **`ToolRegistry`**,
  `src/skills/registry.ts`). "What can the LLM call right now?" Native tools + MCP tools are
  **unified here** because they're the same shape (a callable with typed I/O returning a
  result). Sandboxed scripts of an *active* imported skill also project scoped tools here.
- **Layer 2 — lifecycle registries** (per-kind DB tables + `RegistryService`). "What's
  installed/enabled and how is it managed?" Already separate per kind (native, MCP server,
  channel). The freed-up **`SkillRegistry`** name becomes the *skill* (collection) store +
  lifecycle.

**Organizing principle: unify by runtime shape, separate by lifecycle.** This resolves "why not
a separate registry for MCP?" — MCP *does* have a separate lifecycle registry; it only *shares*
the Layer-1 catalog because it's shape-identical to a native tool.

**Discovery:** keep **separate stores, unified discovery** — `skillSearch` spans tools and
skills, returning "a tool you can call" or "a skill you can activate."

---

## 5. Directory shape & manifest convergence

The vocabulary makes native and imported skills the *same object on disk*:

```
skills/
  calendar/                  # native skill (bundle)
    SKILL.md                 #   description + instructions + owned tools
    tools/
      create-event/   tool.json + handler.ts   # atoms: per-tool action_risk, sensitivity
      list-calendars/ tool.json + handler.ts
  task-management/           # native skill that leads with an instruction block
    SKILL.md
    tools/ …
  not-a-lawyer/              # imported Claude skill — same shape, zero code
    SKILL.md
    references/*.md
```

`SKILL.md` **is** the skill (bundle) manifest; the owned tools are the atoms. Anthropic's format
and Curia's future format become one object:
- **Native skill** = a `SKILL.md` whose tools are in-repo TypeScript (`tool.json` + handler).
- **Imported skill** = a `SKILL.md` whose tools are absent (pure instructions) or sandboxed
  scripts.

**Import = just another skill on disk.** The manifest requirement (`tool.json`) applies only to
*in-process, trusted* tools — never to imported instructions or sandboxed scripts (§8).

---

## 6. Activation, selection & context budget

**Two orthogonal axes** (separating them dissolves the pinned-vs-progressive-disclosure tension):
- **Availability** — pinned (curated, always in toolkit) vs discoverable (search, gated by
  `allow_discovery`).
- **Instruction-loading** — eager (in prompt turn 1) vs lazy (loaded on activation). Pinned ≠ eager.

**Tiered lookup:**
- **Tier 0 — pinned skills** (always available; expresses curation/intent, not just perf).
- **Tier 1 — skills already activated for THIS task** (from durable task state; = the
  persistence mechanism below).
- **Tier 2 — discovery** over the global set, only if 0/1 miss AND `allow_discovery: true`.

**Context bloat is smaller than it feels + self-limiting:**
- *Tool-schema cost* — already paid today; bundling REDUCES it (pin 5 skills, not 30 atoms;
  discoverable skills' schemas absent until activated). New baseline < today.
- *Instruction cost* — new, but only for instruction-heavy skills (`calendar` ≈ 0;
  `task-management` ≈ 400 tokens, already paid via `enable_task_management`). Heavy skills →
  make discoverable + lazy, not pinned.
- Imported skills / MCP rarely pinned → never touch baseline.

**Persistence across wakes (the key question):** Curia ≠ Claude Code. Claude Code/Cowork = one
append-only transcript → skills stay loaded until compaction, then re-attach most-recent
(first ~5k tokens each, 25k total budget). Curia = task-scoped wakes reassembled from durable
state → persistence is NOT automatic, which is an ADVANTAGE (re-decide each wake).
**Recommendation:** record skill activation as durable task state; on each wake re-load the
active skill(s) as a strong prior but re-check relevance vs the current step; cap the active set
(à la the 25k budget). Skill activation becomes a facet of Curia's existing park-and-resume task
model — and Tier 1 above IS this mechanism.

---

## 7. Executable code & the sandbox

An imported skill can bundle three payloads; they get different verdicts:
1. **NL body** — prose the model reads. Trivial.
2. **Reference files & assets loaded at runtime** — read, not executed. **Easy yes** — same
   trust surface as the body; core to progressive disclosure.
3. **Executable scripts** — **the one real build.**

On (3): the reason Curia trusts in-repo `handler.ts` is that it's reviewed + in-process. An
imported script is untrusted code. So the requirement isn't "no code" — it's **"untrusted code
needs a sandbox."** Silently dropping scripts is a trap (the SKILL.md references
`scripts/x.py`, confusing failure). Concrete threat: Curia's process holds live CEO credentials;
prompt-injection → run bundled script → exfiltration. The sandbox is what neutralizes it.

**Shape if built:** container/microVM per execution, **no network, no secrets injected,
ephemeral FS**, and a **controlled RPC bridge** so sandboxed code requests Curia tools instead
of touching them. MCP least-privilege stdio spawning is the seed of the mechanism. No-network ⇒
skill deps must be vendored/pre-provisioned.

This is the highest-cost item and the only one that reverses a deliberate stance (`file-reader`/
`file-writer` were cut after a security review over exactly this vector). **Sequence it last** —
"assets yes, scripts no (with a clear import-time warning)" is a viable interim that still ships
the NL-only 80% case.

---

## 8. Import & trust model

**Install channel (per operator intent):** the operator drops a skill folder into the
container's skills directory (same mechanism as today's `curia-deploy/custom/skills/`) and
restarts. **No console upload. No runtime self-installation.**

**Trust boundary = filesystem + restart = already full trust.** Anyone who can place files in the
container and restart it can change *any* code. So an uploaded skill folder sits at exactly the
trust level of today's custom skills — no signing, no review gate, nothing beyond "it's on disk."

**No manifest parity required — and it's safe, not merely convenient**, because of one invariant:

> **An imported skill cannot expand the activating agent's authority.**

It adds only:
1. **Instructions** — context that can only steer the agent toward tools it *already* holds.
   Prose cannot grant `email-send` to an agent that wasn't pinned/allowed it.
2. **Sandboxed scripts** — isolated compute whose *only* path to a real-world effect is the
   execution-layer RPC bridge, which exposes only tools the activating agent may already call,
   each still passing its own `action_risk`/`sensitivity`/autonomy gate under that agent's
   identity + `allowed_callers`.

So the two enforcement points that already exist — **per-tool execution gates + the sandbox** —
fully cover imported skills. The manifest was the gate for *in-process, trusted* tools; imported
scripts are gated by *isolation* instead. Manifest parity is therefore unnecessary. Effective
risk of an imported skill = bounded by the tools the activating agent already holds; it
introduces no ungated capability.

**Non-goals:** console upload UI, self-install/self-enable, network-fetching skills, granting an
imported skill tool access the agent didn't already have.

---

## 9. Suggested sequencing (if pursued)

1. **tool/skill rename** — pure groundwork, cheapest pre-1.0, everything sits on it. (Atom
   "skill" → "tool"; `SkillRegistry` → `ToolRegistry`; free the `skill` name.)
2. **Bundle (skill) model** — the collection level: `pinned_skills` pins bundles; retire
   `enable_task_management` into a normal skill; native `SKILL.md` + `tools/` layout.
3. **Imported NL+asset skills** — `SKILL.md` + references, no scripts; tiered activation +
   task-state persistence; import-time warning if scripts present.
4. **Execution sandbox** — only if the script-bearing share of the target skill universe
   justifies it (open question below).

---

## 10. Open questions

- **Skill-level gating knobs:** does a skill *aggregate/display* its tools' risk, or move any
  gate (e.g. `allowed_callers`) to the skill level for convenience, with per-tool override?
- **Fine-grained pin override:** pin a skill but exclude a tool (e.g. `calendar` without
  `calendar-delete-event`)? Needed, or YAGNI?
- **Selection UX for skills with instructions:** how does discovery weigh a skill's description
  vs its cost before activating? (Anthropic leans entirely on the description string.)
- **Sandbox go/no-go:** what fraction of the skills operators actually want to import ship
  scripts vs NL+assets? That ratio decides whether §7 is worth building.
- **Migration mechanics:** renaming ~111 tools + `pinned_skills` semantics + the DB table
  without breaking prod (dual-read window? one-shot migration + reconcile?).

---

## 11. Prior art / harness reference

- **Claude Code & Cowork are the same harness** (Cowork = repackaged for knowledge work). Pure
  progressive disclosure, 3 tiers (name+desc preloaded → `SKILL.md` on relevance → references on
  demand). **No "pinned" concept** — generalist agents; `CLAUDE.md` is the always-on layer.
  Persistence via the append-only transcript + bounded re-attach on compaction (~5k/skill, 25k
  total). Curia's `pinned_skills` and task-state persistence are *justified divergences* —
  Curia's agents are specialists and its turns are task-scoped, not one transcript.
- Sources: Claude Cowork skills overview; Anthropic Agent Skills docs (3-tier disclosure);
  Claude Code context-engineering / continual-learning writeups (re-attach budget).

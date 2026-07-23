# Importing an Anthropic Agent Skill

Curia can load an **unmodified** [Anthropic Agent Skill](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — a folder with `SKILL.md` plus optional `references/` / `assets/` — as a Curia skill bundle. No `tool.json`, no Curia-specific manifest, and no scripts executed (script sandbox is Phase 4).

This is Phase 3 of the tools/skills rework (#1490). Design:
[`docs/wip/2026-07-16-tools-skills-architecture-design.md`](../wip/2026-07-16-tools-skills-architecture-design.md).

## What you get

| Payload | Behavior |
|---------|----------|
| `SKILL.md` (name + description + body) | Discovered and activatable. Body injected on `skill-activate` (or at bootstrap if pinned). |
| `references/*.md`, `assets/*` | Listed at activation; loaded on demand via `skill-activate({ skill, reference })`. |
| `scripts/` | **Warned at import, never run.** Instructions + assets still load. |

**Authority containment:** an imported skill cannot expand the activating agent's tool authority. Instructions only steer toward tools the agent already holds (`allowed_callers` / `action_risk` still apply). Imported skills typically declare no tools at all.

## Operator flow (drop folder + enable + restart)

Same install channel as custom deploy skills (`curia-deploy/custom/skills/` or the container `skills/` directory):

1. **Drop** the skill folder onto disk so it sits next to other skills:
   ```text
   skills/
     not-a-lawyer/           # example: https://github.com/maxtremaine/ai-playbook/tree/main/skills/not-a-lawyer
       SKILL.md
       references/
         common-clauses.md
         drafting-comments.md
   ```
2. **Restart** once so discovery sees the folder (it appears in the skill registry as **uninstalled** — imported skills are not auto-enabled; that would be self-enable, a non-goal).
3. **Install + enable** in the console (**Settings → Skills**) or via the registry API:
   ```bash
   curl -X POST -H "Cookie: …" \
     https://your-host/api/registry/skills/not-a-lawyer/install-enable
   ```
4. **Restart again** so the enabled skill is loaded into `SkillRegistry`.
5. Give a relevant agent access:
   - **Discoverable (typical):** set `allow_discovery: true` on the agent (e.g. coordinator). It receives `tool-registry` + `skill-activate`.
   - **Pinned (optional):** add the skill name to `pinned_skills` for always-on instructions.

### Example activation

```text
tool-registry({ query: "contract review" })
# → { name: "not-a-lawyer", kind: "skill", … }

skill-activate({ skill: "not-a-lawyer" })
# → SKILL.md body + list of references/

skill-activate({ skill: "not-a-lawyer", reference: "common-clauses.md" })
# → loads references/common-clauses.md into the turn
```

Tiered lookup (pinned → task-active → discovery) and wake persistence are the Phase 3a activation runtime (#1495); imported skills are ordinary consumers of that path.

## Scripts warning

If the folder contains `scripts/`, startup logs a warning such as:

```text
Imported skill ships a scripts/ directory — scripts are NOT executed (Phase 3). …
```

The skill still loads. Do not expect `scripts/*.py` (or similar) to run until the Phase 4 sandbox ships.

## Trust model

Anyone who can place files in the container and restart it already has full trust — the same bar as today's custom skills. There is no signing gate, no console upload UI, and no runtime self-install. See design §8.

## Related

- [Adding a Tool](adding-a-tool.md) — authoring native Curia tools (`tool.json` + handler)
- [Tools & Execution Spec](../specs/03-tools-and-execution.md) — discovery & activation
- [Configuration → registry](configuration.md#skill-agent-and-channel-registry) — install/enable lifecycle

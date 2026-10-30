# ADR-056: Agents declare the documents and settings they work from (`pinned_context`)

Date: 2026-10-29
Status: Accepted

## Context

Agents keep principal-authored standing policy in `config-store`. That has three problems.

1. **Size.** config-store caps a value at 2000 characters. ceo-inbox's email rules
   (`ceo_inbox`/`rules`) regularly outgrow it, and calendar's scheduling rules have the same
   shape. Raising the cap for everyone is the wrong fix: config-store values are KG facts,
   and most should stay small scalars.
2. **Loading is prose.** Each agent loads its settings through a "call config-store first"
   step in its system prompt. That costs a tool call on every run (every 15 minutes for
   inbox triage) and depends on the model following the step.
3. **Editing is all-or-nothing.** A rule list stored as one JSON value is rewritten whole to
   change one rule.

The OKF document workspace already has no length cap, section-level edits with optimistic
concurrency, and a console editor. It was unsafe for durable settings for two reasons.
`doc-write` stamped the bound task's root id on any path, and project archival archives
every live document carrying that id, so a settings document written during a task-bound
wake could be archived when that project completed. And nothing marked a document as part
of how an agent works: nothing loaded it reliably, and nothing kept unrelated agents from
writing it.

Alternatives considered:

- **Raise config-store's cap, or add a large-value variant.** Keeps the prose load step and
  whole-value rewrites, and puts long free text into the KG.
- **Per-agent folders (`/agents/<name>/…`).** One document can't belong to two agents, and
  sharing one is a real need: two custom agents (an essay scout and an editor) maintaining
  one ledger.
- **Inject whole config namespaces.** Namespaces mix principal settings with agent runtime
  state (watermarks, `seen:` keys; #940). Injecting them would undo the context-diet work.
- **Reference-only injection (path and version, no body).** Brings back the load step this
  is meant to remove. Not needed by any current consumer.

## Decision

An agent YAML may declare `pinned_context`, a mapping with two optional lists. "Pinned"
parallels `pinned_skills`: always present for this agent.

```yaml
pinned_context:
  docs:                                   # a string, or a list of any length
    - /shared/inbox/rules.md
    - path: /shared/priorities.md
      description: The principal's highest priorities, learned by asking them.
  configs:                                # a string, or a list of any length
    - ceo_inbox/decision_tagging
    - key: ceo_inbox/watermark
      description: ID of the last message processed. If missing, start from the newest.
```

- **`docs`** are OKF documents under `/shared/`. **`configs`** are single config-store keys,
  `<namespace>/<key>`. Docs and configs are separate lists because they differ in where
  they live, who may write them, and what "missing" means. An agent may declare as many
  of each as it needs.
- **Descriptions are optional.** A list item is either a bare string or a mapping with
  `path` (docs) or `key` (configs) and a one-line `description` (300 characters at most).
  The description renders under the item's heading in every state, so a document or key
  that does not exist yet still says what it is for and what its absence means. It is
  also the declaration a diagnostics or setup check can read without loading the content.
  It's `configs`, not `settings`, because a key may be runtime state such as a watermark
  rather than a principal setting (#940).

- **Injection.** On every turn `buildBaseSystemPrompt` renders a `## Pinned context` block
  after the YAML body and specialist roster, before the per-turn blocks (autonomy, time).
  Each document shows its path, version and full content (frontmatter and body); each key
  shows its value. Reads are fresh every turn, so a console edit applies on the next turn.
  Content is fenced so a document's own headings and fences can't break the block.
- **Missing vs failed.** A document or key that doesn't exist yet renders as not yet
  created, so the agent knows to create it. A failed read renders as unavailable and logs a
  warning, and the agent is told not to create or overwrite it that turn. A failed read is
  never silently left out. A document the principal archived renders as archived, and
  `doc-write` refuses to `create` over it, so the console restore stays possible.
- **Declaration is write permission.** `doc-write` writes a `/shared/` path only for an
  agent that declares it. Every declaring agent may write; concurrent edits are handled by
  `expected_version` / `expected_section_version`. The console doesn't go through
  `doc-write` and is unaffected. A principal-approved re-execution (ADR-018) carries no
  agent and is allowed, since it's the principal's own decision.
- **Durability by prefix.** `/shared/` joins `DURABLE_DOC_PREFIXES` with `/meetings/`
  (#2322). `doc-write` never stamps a task id on a durable path, and project archival
  excludes durable prefixes. The rule is a path predicate, so archival and the scratch TTL
  sweep never need to load agent YAML, and it stays correct if a declaration briefly
  disappears mid-deploy.
- **Config entries are inject-only.** Writes still go through `config-store`, with no new
  guard. Guarding them needs the settings/runtime-state split in #940.
- **Size is warned, not truncated.** An item longer than
  `documentWorkspace.pinnedContextWarnChars` (default 16000) logs a warning each turn and
  is injected in full. A truncated settings document would be worse than a large one.
- **Missing and blank are states, not errors.** An empty or absent list is no entries.
  A document that exists with no content and a config key set to a blank value each
  render as such. The renderer never throws: any read that fails or returns something
  malformed renders that one entry as unavailable.
- **Validated at load.** A malformed entry or unknown key, a doc outside `/shared/` (after
  path normalization), a reserved leaf (`index.md`, `log.md`), a doc not ending in `.md`
  (the console edits only `.md`), a config without exactly one `/`, a blank or over-long
  description, or a duplicate fails the agent's load with an error naming the agent and the entry.
- **Self-describing documents.** Each `/shared/` document states its own format in its
  frontmatter or a short top section, so every declaring agent follows one format and no
  declaring prompt restates it.

## Consequences

- An agent's standing settings can grow past 2000 characters and be edited a section at a
  time, by the agent or by the principal in the console.
- Declaring agents lose a tool call per run and the prompt step that loaded their settings.
  ceo-inbox and calendar moved their standing rules onto this, and meeting-debrief its settings, in #2339.
- Everything declared is sent on every turn. That's right for settings the agent applies on
  most turns and wrong for anything rarer, which should stay an on-demand read. The size
  warning surfaces a document that has grown too large to inject; per-entry load modes can
  be added then.
- The per-turn system prompt gains a source (`pinnedContextReader`). External renderers
  that build prompts from `resolveSystemPromptSources` (curia-deploy's eval loader) must
  supply it.
- `/shared/` is a third workspace lifecycle alongside task-owned `/projects/` and TTL-swept
  `/scratch/`. New durable folders join the same prefix list rather than adding their own
  exemptions.

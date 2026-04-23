# ADR-014: Capability-tier model routing over per-agent model declarations

Date: 2026-04-10
Status: Accepted

## Context

The current agent config schema (`agents/*.yaml`) requires each agent to declare a specific LLM model and provider:

```yaml
model:
  provider: anthropic
  model: claude-sonnet-4-6
  fallback:
    provider: openai
    model: gpt-4o
```

This design has several problems:

**Portability.** A shared or third-party agent that hardcodes `claude-sonnet-4-6` will fail or silently degrade on any instance that doesn't have that model enabled, or on a deployment targeting a different cloud provider (e.g., a Bedrock model ID means nothing on GCP).

**Operator control.** When model IDs live in agent YAML files, the instance operator cannot centrally change which model is used for a class of agents. Upgrading to a new model requires touching every agent file. Cost routing, model pinning during outages, and A/B testing require per-file edits rather than a config change.

**Security surface.** An untrusted agent config (e.g., a shared agent installed from an external source) can specify an expensive, high-quota, or differently-safety-tuned model. There is no layer enforcing what models agents are allowed to request.

**Auditability.** When each agent may run a different model, answering "what model handled this request?" requires per-agent archaeology instead of a system-level mapping lookup.

The alternatives considered were:
- **Keep per-agent model declarations** — rejected for the reasons above
- **Single global model** — too blunt; legitimate need for fast/cheap vs. capable/expensive routing exists
- **Capability tier + operator mapping** — chosen; agents declare intent, operator resolves to models

## Decision

Replace per-agent model declarations with a **capability tier** system.

**Agents declare a tier and optional capability needs:**

```yaml
model:
  tier: standard          # fast | standard | powerful
  needs: []               # optional: [vision, large_context, reasoning, coding, audio, image_generation]
```

**The operator maps tiers to models in `config/default.yaml`:**

```yaml
model_routing:
  fast:
    provider: anthropic
    model: claude-haiku-4-5
  standard:
    provider: anthropic
    model: claude-sonnet-4-6
  powerful:
    provider: anthropic
    model: claude-opus-4-6
  fallback:
    provider: openai
    model: gpt-4o
```

**Tier semantics:**

| Tier | Intended use | Example agents |
|------|-------------|----------------|
| `fast` | Classification, routing, simple extraction | Dispatch classifier, triage |
| `standard` | General-purpose task execution | Coordinator, expense-tracker |
| `powerful` | Complex multi-step reasoning, synthesis | Research analyst, long-horizon planning |

**Capability needs** are optional flags that constrain model selection within a tier. If the mapped model for a tier doesn't satisfy a declared need, the runtime logs a warning and falls back to the next tier up that does. The supported needs are:

| Need | Meaning | Example models |
|------|---------|---------------|
| `vision` | Multimodal image understanding (input) | claude-sonnet-4-6, gpt-4o |
| `large_context` | Extended context window (100k+ tokens) | claude-opus-4-6, gemini-1.5-pro |
| `reasoning` | Extended chain-of-thought / scratchpad reasoning | claude-opus-4-6 (extended thinking), o3 |
| `coding` | Code generation and analysis optimized | claude-sonnet-4-6, gpt-4o, deepseek-coder |
| `audio` | Audio input/output modality | gpt-4o-audio-preview, gemini-1.5-pro |
| `image_generation` | Image synthesis output | dall-e-3, imagen-3, stable-diffusion |

**Migration:** Existing `model.provider` + `model.model` fields are deprecated but remain valid during a transition period. At startup, the runtime emits a deprecation warning for any agent still using the old schema. A migration guide documents the mapping.

## Consequences

**Positive:**
- Agent YAML files are portable across instances, clouds, and deployments — they declare intent, not implementation
- The operator controls model selection in one place; upgrading all `standard` agents to a new model is a single config change
- The system can implement cost routing, fallback, and A/B testing at the routing layer without touching agent files
- Security enforcement is centralized — operators whitelist which models are available; agents cannot escalate beyond what's configured
- Auditing is simplified — the runtime logs `tier → resolved_model` at task start, making the full picture visible in one place

**Trade-offs:**
- Agents lose direct control over which model executes their prompts. Agents that have been carefully tuned for a specific model's behavior may need re-evaluation when the operator changes the tier mapping.
- The `needs` system covers the main modality and capability classes (`vision`, `large_context`, `reasoning`, `coding`, `audio`, `image_generation`), but agents with requirements outside this set (e.g., a specific fine-tune) must use a named alias approach rather than declaring a raw model ID.
- The transition period (supporting both old and new schema) adds short-term complexity to the validation layer.

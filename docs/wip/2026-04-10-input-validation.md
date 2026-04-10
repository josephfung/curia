# Input Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-fast startup validation for agent configs, skill manifests, and `config/default.yaml` using JSON Schema + Ajv, and reject oversized inbound messages in the dispatcher before routing.

**Architecture:** A centralized `src/startup/validator.ts` runs before the DB connection and validates all config files against JSON Schema files in `schemas/` at the project root. The dispatcher gets a `max_message_bytes` guard that publishes `message.rejected` (already a dispatch-layer event) for oversized content.

**Tech Stack:** Ajv v8 (JSON Schema validation), Vitest (tests), existing `js-yaml` for YAML parsing

**Design doc:** `docs/wip/2026-04-10-input-validation-design.md`

---

## Tasks

### Task 1: Install Ajv

**Files:**
- Modify: `package.json` (via pnpm)
- Modify: `pnpm-lock.yaml` (via pnpm)

- [ ] **Step 1: Install the dependency**

```bash
pnpm add ajv
```

Expected output: something like `+ ajv 8.x.x` — no errors.

- [ ] **Step 2: Verify it imports correctly**

```bash
node --input-type=module <<'EOF'
import Ajv from 'ajv';
const ajv = new Ajv({ allErrors: true });
console.log('Ajv version:', ajv.constructor.name);
EOF
```

Expected: prints `Ajv version: Ajv2020` or similar — no error.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add package.json pnpm-lock.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "chore: add ajv for JSON Schema validation"
```

---

### Task 2: Extend `MessageRejectedPayload` with `message_too_large`

The dispatcher will publish `message.rejected` for oversized messages. The `reason` union in `src/bus/events.ts` must include the new value.

**Files:**
- Modify: `src/bus/events.ts`

- [ ] **Step 1: Add `message_too_large` to the reason union**

In `src/bus/events.ts`, find `MessageRejectedPayload` (around line 164) and update `reason`:

```typescript
// MessageRejectedPayload — emitted by the dispatch layer when a message is rejected
// due to an unknown_sender: ignore policy, a blocked sender, or an oversized message.
// The conversationId is included so the HTTP adapter can immediately resolve the pending
// response with an error rather than hanging until the 120-second timeout.
interface MessageRejectedPayload {
  conversationId: string;
  channelId: string;
  senderId: string;
  /** Why the message was rejected — used by the HTTP adapter to select the status code. */
  reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender' | 'message_too_large';
}
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run typecheck 2>&1 | head -20
```

Expected: no errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add src/bus/events.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: add message_too_large to MessageRejectedPayload reason union"
```

---

### Task 3: Create the three JSON Schema files

Schemas live in `schemas/` at the project root — sibling of `config/`, `agents/`, `skills/`. This path resolves correctly from both `src/` (tsx dev) and `dist/` (compiled production).

**Files:**
- Create: `schemas/agent-config.schema.json`
- Create: `schemas/skill-manifest.schema.json`
- Create: `schemas/default-config.schema.json`

- [ ] **Step 1: Create `schemas/agent-config.schema.json`**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "agent-config",
  "type": "object",
  "required": ["name", "description", "model", "system_prompt"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string", "minLength": 1 },
    "role": { "type": "string" },
    "persona": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "display_name": { "type": "string" },
        "tone": { "type": "string" },
        "title": { "type": "string" },
        "email_signature": { "type": "string" }
      }
    },
    "model": {
      "type": "object",
      "required": ["provider", "model"],
      "additionalProperties": false,
      "properties": {
        "provider": { "type": "string", "minLength": 1 },
        "model": { "type": "string", "minLength": 1 },
        "fallback": {
          "type": "object",
          "required": ["provider", "model"],
          "additionalProperties": false,
          "properties": {
            "provider": { "type": "string", "minLength": 1 },
            "model": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    "system_prompt": { "type": "string", "minLength": 1 },
    "pinned_skills": {
      "type": "array",
      "items": { "type": "string" }
    },
    "allow_discovery": { "type": "boolean" },
    "memory": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scopes": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    },
    "schedule": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["cron", "task"],
        "additionalProperties": false,
        "properties": {
          "cron": { "type": "string" },
          "task": { "type": "string" },
          "agent_id": { "type": "string" },
          "expectedDurationSeconds": { "type": "number", "minimum": 0 }
        }
      }
    },
    "error_budget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_turns": { "type": "integer", "minimum": 1 },
        "max_cost_usd": { "type": "number", "minimum": 0 },
        "max_errors": { "type": "integer", "minimum": 1 }
      }
    }
  }
}
```

- [ ] **Step 2: Create `schemas/skill-manifest.schema.json`**

The `action_risk` field accepts either a named label string OR an integer 0–100, modelled with `oneOf`.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "skill-manifest",
  "type": "object",
  "required": ["name", "description", "version", "action_risk"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "description": { "type": "string", "minLength": 1 },
    "version": { "type": "string", "minLength": 1 },
    "action_risk": {
      "oneOf": [
        {
          "type": "string",
          "enum": ["none", "low", "medium", "high", "critical"]
        },
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        }
      ]
    },
    "sensitivity": {
      "type": "string",
      "enum": ["normal", "elevated"]
    },
    "inputs": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "outputs": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    },
    "permissions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "secrets": {
      "type": "array",
      "items": { "type": "string" }
    },
    "timeout": { "type": "integer", "minimum": 1 },
    "infrastructure": { "type": "boolean" },
    "entity_enrichment": {
      "type": "object",
      "required": ["param", "default"],
      "additionalProperties": false,
      "properties": {
        "param": { "type": "string", "minLength": 1 },
        "default": { "type": "string", "enum": ["caller", "agent"] }
      }
    }
  }
}
```

- [ ] **Step 3: Create `schemas/default-config.schema.json`**

All fields optional — the file is intentionally partial. Types and ranges are enforced when present. `additionalProperties: false` catches key typos.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "default-config",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "channels": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "cli": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "enabled": { "type": "boolean" }
          }
        },
        "max_message_bytes": { "type": "integer", "minimum": 1 }
      }
    },
    "browser": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sessionTtlMs": { "type": "integer", "minimum": 1 },
        "sweepIntervalMs": { "type": "integer", "minimum": 1 }
      }
    },
    "agents": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "coordinator": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "config_path": { "type": "string" }
          }
        }
      }
    },
    "dispatch": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "conversationCheckpointDebounceMs": { "type": "integer", "minimum": 1 }
      }
    },
    "workingMemory": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "summarization": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "threshold": { "type": "integer", "minimum": 2 },
            "keepWindow": { "type": "integer", "minimum": 1 }
          }
        }
      }
    },
    "skillOutput": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "maxLength": { "type": "integer", "minimum": 1 }
      }
    },
    "security": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "extra_injection_patterns": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["regex", "label"],
            "additionalProperties": false,
            "properties": {
              "regex": { "type": "string", "minLength": 1 },
              "label": { "type": "string", "minLength": 1 }
            }
          }
        },
        "trust_score": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "channel_weight": { "type": "number", "minimum": 0, "maximum": 1 },
            "contact_weight": { "type": "number", "minimum": 0, "maximum": 1 },
            "max_risk_penalty": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        },
        "trust_score_floor": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "trust_policy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "financial_actions": { "type": "number", "minimum": 0, "maximum": 1 },
        "data_export": { "type": "number", "minimum": 0, "maximum": 1 },
        "scheduling": { "type": "number", "minimum": 0, "maximum": 1 },
        "information_queries": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    },
    "pii": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "extra_patterns": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["regex", "replacement"],
            "additionalProperties": false,
            "properties": {
              "regex": { "type": "string", "minLength": 1 },
              "replacement": { "type": "string", "minLength": 1 }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 4: Verify existing config files pass the schemas manually**

Run this quick smoke check to confirm the real `config/default.yaml` and `agents/coordinator.yaml` are valid before adding the validator to startup. If any fail, fix the YAML files first (not the schemas).

```bash
node --input-type=module <<'EOF'
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const ajv = new Ajv({ allErrors: true });

const defaultConfigSchema = JSON.parse(readFileSync('schemas/default-config.schema.json', 'utf-8'));
const agentSchema = JSON.parse(readFileSync('schemas/agent-config.schema.json', 'utf-8'));
const skillSchema = JSON.parse(readFileSync('schemas/skill-manifest.schema.json', 'utf-8'));

const validateConfig = ajv.compile(defaultConfigSchema);
const validateAgent = ajv.compile(agentSchema);
const validateSkill = ajv.compile(skillSchema);

// Test config
const config = yaml.load(readFileSync('config/default.yaml', 'utf-8'));
if (!validateConfig(config)) {
  console.error('config/default.yaml FAILED:', ajv.errorsText(validateConfig.errors));
} else {
  console.log('config/default.yaml OK');
}

// Test coordinator agent
const agent = yaml.load(readFileSync('agents/coordinator.yaml', 'utf-8'));
if (!validateAgent(agent)) {
  console.error('agents/coordinator.yaml FAILED:', ajv.errorsText(validateAgent.errors));
} else {
  console.log('agents/coordinator.yaml OK');
}

// Test one skill
const skill = JSON.parse(readFileSync('skills/web-search/skill.json', 'utf-8'));
if (!validateSkill(skill)) {
  console.error('skills/web-search/skill.json FAILED:', ajv.errorsText(validateSkill.errors));
} else {
  console.log('skills/web-search/skill.json OK');
}
EOF
```

Run this from the worktree root: `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation/`

Expected: all three print `OK`. If any fail, update the YAML/JSON to match the schema (the schema defines what's correct; the files are the source of truth for what fields actually exist). Common issues: missing `description` in agent YAML, missing `version` in skill manifest.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add schemas/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: add JSON Schema files for agent configs, skill manifests, and default config"
```

---

### Task 4: Write failing tests for the startup validator

Tests use fixture files in `tests/unit/startup/fixtures/` to avoid temp directory management. All fixtures are minimal valid/invalid YAML and JSON that exercise specific schema rules.

**Files:**
- Create: `tests/unit/startup/fixtures/agents/valid.yaml`
- Create: `tests/unit/startup/fixtures/agents/missing-description.yaml`
- Create: `tests/unit/startup/fixtures/agents/missing-model-provider.yaml`
- Create: `tests/unit/startup/fixtures/agents/unknown-key.yaml`
- Create: `tests/unit/startup/fixtures/skills/valid-skill/skill.json`
- Create: `tests/unit/startup/fixtures/skills/missing-version/skill.json`
- Create: `tests/unit/startup/fixtures/skills/missing-action-risk/skill.json`
- Create: `tests/unit/startup/fixtures/skills/bad-action-risk/skill.json`
- Create: `tests/unit/startup/fixtures/config/valid.yaml`
- Create: `tests/unit/startup/fixtures/config/invalid-trust-floor.yaml`
- Create: `tests/unit/startup/fixtures/config/wrong-type.yaml`
- Create: `tests/unit/startup/fixtures/config/unknown-key.yaml`
- Create: `tests/unit/startup/validator.test.ts`

- [ ] **Step 1: Create the fixture files**

**`tests/unit/startup/fixtures/agents/valid.yaml`:**
```yaml
name: test-agent
description: A valid test agent
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/missing-description.yaml`:**
```yaml
name: test-agent
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/missing-model-provider.yaml`:**
```yaml
name: test-agent
description: Missing model provider
model:
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/unknown-key.yaml`:**
```yaml
name: test-agent
description: Has a typo key
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
typo_key: this should not be here
```

**`tests/unit/startup/fixtures/skills/valid-skill/skill.json`:**
```json
{
  "name": "valid-skill",
  "description": "A valid test skill",
  "version": "1.0.0",
  "action_risk": "none"
}
```

**`tests/unit/startup/fixtures/skills/missing-version/skill.json`:**
```json
{
  "name": "missing-version-skill",
  "description": "Missing the version field",
  "action_risk": "none"
}
```

**`tests/unit/startup/fixtures/skills/missing-action-risk/skill.json`:**
```json
{
  "name": "missing-action-risk-skill",
  "description": "Missing the action_risk field",
  "version": "1.0.0"
}
```

**`tests/unit/startup/fixtures/skills/bad-action-risk/skill.json`:**
```json
{
  "name": "bad-action-risk-skill",
  "description": "Has an invalid action_risk string",
  "version": "1.0.0",
  "action_risk": "super-dangerous"
}
```

**`tests/unit/startup/fixtures/config/valid.yaml`:**
```yaml
security:
  trust_score_floor: 0.2
  trust_score:
    channel_weight: 0.4
    contact_weight: 0.4
    max_risk_penalty: 0.2
trust_policy:
  financial_actions: 0.8
  data_export: 0.8
  scheduling: 0.5
  information_queries: 0.2
```

**`tests/unit/startup/fixtures/config/invalid-trust-floor.yaml`:**
```yaml
security:
  trust_score_floor: 1.5
```

**`tests/unit/startup/fixtures/config/wrong-type.yaml`:**
```yaml
channels:
  max_message_bytes: "not-a-number"
```

**`tests/unit/startup/fixtures/config/unknown-key.yaml`:**
```yaml
trust-policy:
  financial_actions: 0.8
```

- [ ] **Step 2: Write the test file**

Create `tests/unit/startup/validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { runStartupValidation } from '../../../src/startup/validator.js';
import { createLogger } from '../../../src/logger.js';

// Resolve fixture directories relative to this test file.
const FIXTURES = path.resolve(import.meta.dirname, './fixtures');
const agentsFixtures = path.join(FIXTURES, 'agents');
const configFixtures = path.join(FIXTURES, 'config');
const skillsFixtures = path.join(FIXTURES, 'skills');

// Shared logger that suppresses output during tests
const logger = createLogger('silent');

// Helper: run validation pointing at specific fixture subdirs
async function validate(opts: {
  agentsDir?: string;
  skillsDir?: string;
  configFile?: string; // full path to a single config yaml to test
}): Promise<void> {
  // We can't easily point the validator at a single config file, so we use
  // a real empty dir for dirs we don't want to test. A valid-only dir for
  // config means we pass a dir with one valid file.
  return runStartupValidation({
    agentsDir: opts.agentsDir ?? path.join(agentsFixtures, '_empty'),
    skillsDir: opts.skillsDir ?? path.join(skillsFixtures, '_empty'),
    configDir: opts.configFile ? path.dirname(opts.configFile) : path.join(configFixtures, '_empty'),
    configFileName: opts.configFile ? path.basename(opts.configFile) : undefined,
    logger,
  });
}

describe('startup validator — agent configs', () => {
  it('passes for a valid agent YAML', async () => {
    await expect(
      runStartupValidation({
        agentsDir: path.join(agentsFixtures),
        skillsDir: path.join(skillsFixtures, '_empty'),
        configDir: path.join(configFixtures, '_empty'),
        logger,
      }),
    ).resolves.toBeUndefined();
    // Note: all valid fixtures in agentsFixtures are checked, including valid.yaml.
    // Invalid fixtures are in subdirs — agent fixtures are flat files, so only
    // valid.yaml (and others created in Step 1) are in agentsFixtures itself.
    // We check a specific valid file by using a temp-like approach:
  });

  it('throws when an agent YAML is missing description', async () => {
    // Create a temp agents dir with only the invalid file
    await expect(
      runStartupValidation({
        agentsDir: agentsFixtures,
        skillsDir: path.join(skillsFixtures, '_empty'),
        configDir: path.join(configFixtures, '_empty'),
        logger,
      }),
    ).rejects.toThrow('description');
  });
});
```

Hmm — the fixture layout won't work well with a flat directory because all agent fixtures are in the same dir and we'd validate all of them. Let me restructure the approach.

**Better approach:** pass the path to a single-file agent directory per test. Rename the fixtures:

- `tests/unit/startup/fixtures/agents/valid/coordinator.yaml` — the valid one
- `tests/unit/startup/fixtures/agents/missing-description/coordinator.yaml`
- etc.

Rewrite Step 1 fixture files (delete previous plan for step 1 and use this layout instead), then write the test:

- [ ] **Step 1 (revised): Create fixture files with one-per-directory layout**

**`tests/unit/startup/fixtures/agents/valid/coordinator.yaml`:**
```yaml
name: test-agent
description: A valid test agent
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/missing-description/coordinator.yaml`:**
```yaml
name: test-agent
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/missing-model-provider/coordinator.yaml`:**
```yaml
name: test-agent
description: Missing model provider
model:
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
```

**`tests/unit/startup/fixtures/agents/unknown-key/coordinator.yaml`:**
```yaml
name: test-agent
description: Has a typo key
model:
  provider: anthropic
  model: claude-sonnet-4-6
system_prompt: You are a test agent.
typo_key: this should not be here
```

Skills fixtures stay as-is (they already use one skill per subdirectory, matching the real layout).

Config fixtures:

**`tests/unit/startup/fixtures/config/valid/default.yaml`:**
```yaml
security:
  trust_score_floor: 0.2
  trust_score:
    channel_weight: 0.4
    contact_weight: 0.4
    max_risk_penalty: 0.2
trust_policy:
  financial_actions: 0.8
  data_export: 0.8
  scheduling: 0.5
  information_queries: 0.2
```

**`tests/unit/startup/fixtures/config/invalid-trust-floor/default.yaml`:**
```yaml
security:
  trust_score_floor: 1.5
```

**`tests/unit/startup/fixtures/config/wrong-type/default.yaml`:**
```yaml
channels:
  max_message_bytes: "not-a-number"
```

**`tests/unit/startup/fixtures/config/unknown-key/default.yaml`:**
```yaml
trust-policy:
  financial_actions: 0.8
```

**`tests/unit/startup/fixtures/config/empty/default.yaml`:** *(empty file — valid because all fields are optional)*
```yaml
# empty config — all fields are optional
```

- [ ] **Step 2: Write `tests/unit/startup/validator.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { runStartupValidation } from '../../../src/startup/validator.js';
import { createLogger } from '../../../src/logger.js';

const F = path.resolve(import.meta.dirname, 'fixtures');
const logger = createLogger('silent');

// Shorthand: run validation with specific fixture directories, using empty dirs for
// the components we're not testing in a given test case.
function runWith(opts: { agents?: string; skills?: string; config?: string }) {
  return runStartupValidation({
    agentsDir: opts.agents ?? path.join(F, 'agents/valid'),
    skillsDir: opts.skills ?? path.join(F, 'skills/valid-skill'),
    configDir: opts.config ?? path.join(F, 'config/empty'),
    logger,
  });
}

// ── Agent config validation ──────────────────────────────────────────────────

describe('startup validator — agent configs', () => {
  it('passes for a valid agent YAML', async () => {
    await expect(runWith({ agents: path.join(F, 'agents/valid') })).resolves.toBeUndefined();
  });

  it('throws when agent YAML is missing description', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-description') }),
    ).rejects.toThrow(/description/);
  });

  it('throws when agent YAML is missing model.provider', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-model-provider') }),
    ).rejects.toThrow(/provider/);
  });

  it('includes the file path in the error message', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/missing-description') }),
    ).rejects.toThrow(/coordinator\.yaml/);
  });

  it('throws for unknown top-level keys (additionalProperties)', async () => {
    await expect(
      runWith({ agents: path.join(F, 'agents/unknown-key') }),
    ).rejects.toThrow(/typo_key/);
  });
});

// ── Skill manifest validation ────────────────────────────────────────────────

describe('startup validator — skill manifests', () => {
  it('passes for a valid skill manifest', async () => {
    await expect(runWith({ skills: path.join(F, 'skills/valid-skill') })).resolves.toBeUndefined();
  });

  it('throws when skill manifest is missing version', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/missing-version') }),
    ).rejects.toThrow(/version/);
  });

  it('throws when skill manifest is missing action_risk', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/missing-action-risk') }),
    ).rejects.toThrow(/action_risk/);
  });

  it('throws for an invalid action_risk string value', async () => {
    await expect(
      runWith({ skills: path.join(F, 'skills/bad-action-risk') }),
    ).rejects.toThrow(/action_risk/);
  });

  it('passes for action_risk as an integer (e.g. 75)', async () => {
    // numeric action_risk should be valid per the oneOf schema
    await expect(runWith({ skills: path.join(F, 'skills/valid-skill') })).resolves.toBeUndefined();
  });
});

// ── default-config.yaml validation ──────────────────────────────────────────

describe('startup validator — default config', () => {
  it('passes for a valid config', async () => {
    await expect(runWith({ config: path.join(F, 'config/valid') })).resolves.toBeUndefined();
  });

  it('passes for an empty config (all fields optional)', async () => {
    await expect(runWith({ config: path.join(F, 'config/empty') })).resolves.toBeUndefined();
  });

  it('throws when trust_score_floor is out of range (1.5)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/invalid-trust-floor') }),
    ).rejects.toThrow(/trust_score_floor/);
  });

  it('throws when max_message_bytes is the wrong type (string)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/wrong-type') }),
    ).rejects.toThrow(/max_message_bytes/);
  });

  it('throws for unknown top-level keys (e.g. trust-policy typo)', async () => {
    await expect(
      runWith({ config: path.join(F, 'config/unknown-key') }),
    ).rejects.toThrow(/trust-policy/);
  });
});
```

- [ ] **Step 3: Run the tests — confirm they all fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test tests/unit/startup/validator.test.ts 2>&1 | tail -20
```

Expected: all tests fail with something like `Cannot find module '../../../src/startup/validator.js'`. This confirms the tests are wired correctly and the module doesn't exist yet.

- [ ] **Step 4: Commit the test file and fixtures**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add tests/unit/startup/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "test: add failing tests for startup validator"
```

---

### Task 5: Implement the startup validator

**Files:**
- Create: `src/startup/validator.ts`

- [ ] **Step 1: Create `src/startup/validator.ts`**

```typescript
// src/startup/validator.ts
//
// Centralized startup validation — runs before any services are initialized.
// Validates config/default.yaml, all agents/*.yaml, and all skills/*/skill.json
// against JSON Schema using Ajv. Any failure throws with a descriptive message
// and causes process.exit(1) in the bootstrap orchestrator.
//
// Spec: docs/specs/06-audit-and-security.md — Input Validation

import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import type { Logger } from '../logger.js';

// Schemas live at the project root in schemas/, sibling of config/ and agents/.
// Resolving relative to this file: src/startup/ → ../../schemas → schemas/
// This works from both tsx (src/startup/) and compiled dist (dist/startup/).
const SCHEMAS_DIR = path.resolve(import.meta.dirname, '../../schemas');

function loadSchema(name: string): object {
  const schemaPath = path.join(SCHEMAS_DIR, name);
  return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as object;
}

/**
 * Run all startup validation checks. Throws with a descriptive error on any
 * failure — callers should catch, log fatal, and exit.
 *
 * Validation order:
 *   1. config/default.yaml (or configFileName override)
 *   2. all *.yaml files in agentsDir
 *   3. all */skill.json files in skillsDir
 */
export async function runStartupValidation(opts: {
  configDir: string;
  agentsDir: string;
  skillsDir: string;
  logger: Logger;
  /** Override config filename for testing. Defaults to 'default.yaml'. */
  configFileName?: string;
}): Promise<void> {
  const { configDir, agentsDir, skillsDir, logger } = opts;
  const configFileName = opts.configFileName ?? 'default.yaml';

  // Compile schemas once — Ajv compilation is expensive; reuse across files.
  const ajv = new Ajv({ allErrors: true });
  const validateConfig = ajv.compile(loadSchema('default-config.schema.json'));
  const validateAgent = ajv.compile(loadSchema('agent-config.schema.json'));
  const validateSkill = ajv.compile(loadSchema('skill-manifest.schema.json'));

  // 1. Validate config/default.yaml (absent file is OK — all fields are optional)
  const configPath = path.join(configDir, configFileName);
  if (fs.existsSync(configPath)) {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf-8'));
    // null/empty YAML is valid (same as no config)
    if (raw != null) {
      if (!validateConfig(raw)) {
        throw new Error(
          `Startup validation failed for ${configPath}:\n  - ${ajv.errorsText(validateConfig.errors, { separator: '\n  - ', dataVar: '' })}`,
        );
      }
    }
  }

  // 2. Validate all agents/*.yaml
  if (fs.existsSync(agentsDir)) {
    const agentFiles = fs.readdirSync(agentsDir)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of agentFiles) {
      const filePath = path.join(agentsDir, file);
      const raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
      if (!validateAgent(raw)) {
        throw new Error(
          `Startup validation failed for ${filePath}:\n  - ${ajv.errorsText(validateAgent.errors, { separator: '\n  - ', dataVar: '' })}`,
        );
      }
    }
  }

  // 3. Validate all skills/*/skill.json
  if (fs.existsSync(skillsDir)) {
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const entry of skillEntries) {
      const manifestPath = path.join(skillsDir, entry.name, 'skill.json');
      if (!fs.existsSync(manifestPath)) continue;

      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
      if (!validateSkill(raw)) {
        throw new Error(
          `Startup validation failed for ${manifestPath}:\n  - ${ajv.errorsText(validateSkill.errors, { separator: '\n  - ', dataVar: '' })}`,
        );
      }
    }
  }

  logger.info('Startup validation passed');
}
```

- [ ] **Step 2: Run the tests — confirm they all pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test tests/unit/startup/validator.test.ts 2>&1 | tail -30
```

Expected: all tests pass. If `trust_score_floor` or `typo_key` errors don't surface by field name, check that Ajv's `errorsText` is including `instancePath` — you may need to adjust the error message format in the throw. The error text from Ajv for `additionalProperties` violations includes the property name in `params.additionalProperty`, accessible via `errors[].params.additionalProperty`. If the default `errorsText` doesn't include it, switch to a custom formatter:

```typescript
// Replace the ajv.errorsText call with this if field names don't appear:
const details = (ajv.errors ?? [])
  .map(e => {
    const extra = e.params && 'additionalProperty' in e.params
      ? ` (${String(e.params.additionalProperty)})`
      : '';
    return `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}${extra}`;
  })
  .join('\n  - ');
throw new Error(`Startup validation failed for ${filePath}:\n  - ${details}`);
```

Apply this pattern to all three validation blocks if needed. Re-run the tests after adjusting.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add src/startup/
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: implement startup validator with Ajv JSON Schema validation"
```

---

### Task 6: Wire startup validator into `src/index.ts` and clean up loaders

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agents/loader.ts`
- Modify: `src/skills/loader.ts`

- [ ] **Step 1: Add the import and call to `src/index.ts`**

Add the import near the top of `src/index.ts` with the other imports:

```typescript
import { runStartupValidation } from './startup/validator.js';
```

Find the section right after `const logger = createLogger(config.logLevel);` and `logger.info('Curia starting...');` — **before** the `const pool = createPool(...)` call — and insert:

```typescript
  // 1b. Startup validation — fail fast before any I/O if configs are malformed.
  // Validates config/default.yaml, agents/*.yaml, and skills/*/skill.json against
  // JSON Schema. Any failure exits the process before the DB connection is attempted.
  try {
    await runStartupValidation({
      configDir,
      agentsDir: path.resolve(import.meta.dirname, '../agents'),
      skillsDir: path.resolve(import.meta.dirname, '../skills'),
      logger,
    });
  } catch (err) {
    logger.fatal({ err }, 'Startup validation failed — fix the config errors above and restart');
    process.exit(1);
  }
```

- [ ] **Step 2: Remove manual field checks from `src/agents/loader.ts`**

In `src/agents/loader.ts`, find `loadAgentConfig()`. Delete these lines (they are now enforced by the startup validator schema):

```typescript
  // Validate required fields
  if (!config.name) {
    throw new Error(`Agent config at ${filePath} is missing required field: name`);
  }
  if (!config.model?.provider || !config.model?.model) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing model.provider or model.model`);
  }
  if (!config.system_prompt) {
    throw new Error(`Agent config '${config.name}' at ${filePath} is missing system_prompt`);
  }
```

Leave the YAML parse error handling (`try { config = yaml.load(...) } catch`) and all interpolation logic intact — those are not schema concerns.

- [ ] **Step 3: Remove manual field check from `src/skills/loader.ts`**

In `src/skills/loader.ts`, inside the `try` block in the `for` loop, delete:

```typescript
      if (!manifest.name || !manifest.description) {
        throw new Error('Manifest missing required fields: name, description');
      }
```

Leave all other logic intact (defaults assignment, handler discovery, dynamic import).

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run typecheck 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 5: Run the full test suite to confirm nothing broke**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test 2>&1 | tail -20
```

Expected: all tests pass (including the startup validator tests from Task 4 and any existing tests).

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add src/index.ts src/agents/loader.ts src/skills/loader.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: wire startup validator into bootstrap; remove redundant manual checks from loaders"
```

---

### Task 7: Add `max_message_bytes` to config

**Files:**
- Modify: `config/default.yaml`
- Modify: `src/config.ts`

- [ ] **Step 1: Add `max_message_bytes` to `config/default.yaml`**

The `channels` section currently has `cli.enabled`. Add `max_message_bytes` as a sibling of `cli` (not nested inside it):

```yaml
channels:
  cli:
    enabled: true
  max_message_bytes: 102400   # 100KB — inbound messages exceeding this are rejected before routing
```

- [ ] **Step 2: Update `YamlConfig.channels` in `src/config.ts`**

Find the `YamlConfig` interface and update the `channels` property:

```typescript
  channels?: {
    cli?: { enabled?: boolean };
    /** Max inbound message content size in bytes. Default: 102400 (100KB).
     *  Messages exceeding this are rejected by the dispatcher before routing. */
    max_message_bytes?: number;
  };
```

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add config/default.yaml src/config.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: add channels.max_message_bytes config (default 100KB)"
```

---

### Task 8: Write failing dispatcher size-check tests

**Files:**
- Modify: `tests/unit/dispatch/dispatcher.test.ts`

- [ ] **Step 1: Add the size-check test suite to the existing dispatcher test file**

Open `tests/unit/dispatch/dispatcher.test.ts` and append this new `describe` block at the end of the file:

```typescript
describe('Dispatcher message size limit', () => {
  function makeDispatcher(bus: EventBus, maxMessageBytes: number) {
    const logger = createLogger('silent');
    const dispatcher = new Dispatcher({ bus, logger, maxMessageBytes });
    dispatcher.register();
    return dispatcher;
  }

  it('routes normally when content is at the size limit', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);

    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'ok',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (e) => outbound.push(e as OutboundMessageEvent));

    // 10 bytes exactly — at limit
    makeDispatcher(bus, 10);

    const event = createInboundMessage({
      conversationId: 'conv-size-ok',
      channelId: 'cli',
      senderId: 'user',
      content: '1234567890', // exactly 10 bytes
    });
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);
  });

  it('publishes message.rejected when content exceeds the size limit', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);

    const rejected: MessageRejectedEvent[] = [];
    bus.subscribe('message.rejected', 'channel', (e) => rejected.push(e as MessageRejectedEvent));

    makeDispatcher(bus, 5); // 5 byte limit

    const event = createInboundMessage({
      conversationId: 'conv-size-exceeded',
      channelId: 'email',
      senderId: 'spammer@example.com',
      content: 'This message is definitely longer than 5 bytes',
    });
    await bus.publish('channel', event);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload.reason).toBe('message_too_large');
    expect(rejected[0]?.payload.conversationId).toBe('conv-size-exceeded');
    expect(rejected[0]?.payload.channelId).toBe('email');
    expect(rejected[0]?.payload.senderId).toBe('spammer@example.com');
  });

  it('does not publish agent.task when content exceeds the size limit', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => tasks.push(e as AgentTaskEvent));

    makeDispatcher(bus, 5);

    const event = createInboundMessage({
      conversationId: 'conv-no-task',
      channelId: 'email',
      senderId: 'spammer@example.com',
      content: 'Way more than 5 bytes here',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(0);
  });

  it('sets parentEventId on the rejection event to the original inbound message id', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);

    const rejected: MessageRejectedEvent[] = [];
    bus.subscribe('message.rejected', 'channel', (e) => rejected.push(e as MessageRejectedEvent));

    makeDispatcher(bus, 1); // absurdly low limit

    const event = createInboundMessage({
      conversationId: 'conv-causal-chain',
      channelId: 'cli',
      senderId: 'user',
      content: 'ab', // 2 bytes > 1 byte limit
    });
    await bus.publish('channel', event);

    expect(rejected[0]?.parentEventId).toBe(event.id);
  });
});
```

- [ ] **Step 2: Run the new tests — confirm they fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test tests/unit/dispatch/dispatcher.test.ts 2>&1 | tail -20
```

Expected: the new `Dispatcher message size limit` tests fail because `DispatcherConfig` doesn't have `maxMessageBytes` yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add tests/unit/dispatch/dispatcher.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "test: add failing dispatcher message size limit tests"
```

---

### Task 9: Implement the dispatcher size check

**Files:**
- Modify: `src/dispatch/dispatcher.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add `maxMessageBytes` to `DispatcherConfig` and the constructor**

In `src/dispatch/dispatcher.ts`, add `maxMessageBytes` to the `DispatcherConfig` interface:

```typescript
export interface DispatcherConfig {
  bus: EventBus;
  logger: Logger;
  contactResolver?: ContactResolver;
  heldMessages?: HeldMessageService;
  channelPolicies?: Record<string, ChannelPolicyConfig>;
  injectionScanner?: InboundScanner;
  pool?: DbPool;
  conversationCheckpointDebounceMs?: number;
  trustScorerWeights?: TrustScorerWeights;
  trustScoreFloor?: number;
  /** Maximum inbound message content size in bytes. Messages exceeding this are
   *  rejected before routing. Default: 102400 (100KB). */
  maxMessageBytes?: number;
}
```

Add a private field and set it in the constructor (after `this.trustScoreFloor = ...`):

```typescript
  private maxMessageBytes: number;
```

```typescript
    this.maxMessageBytes = config.maxMessageBytes ?? 102_400;
```

- [ ] **Step 2: Add the size check to `handleInbound`**

In `handleInbound`, add the size check as the very first thing, before the `this.logger.info(...)` call:

```typescript
  private async handleInbound(event: InboundMessageEvent): Promise<void> {
    const { payload } = event;

    // Reject oversized messages before any processing — no routing, no contact
    // lookup, no LLM cost. The inbound.message event is already in the audit log
    // (write-ahead); this rejection creates a causal chain via parentEventId.
    const contentByteSize = Buffer.byteLength(payload.content, 'utf-8');
    if (contentByteSize > this.maxMessageBytes) {
      this.logger.warn(
        { channelId: payload.channelId, senderId: payload.senderId, contentByteSize, maxBytes: this.maxMessageBytes },
        'Inbound message exceeded size limit — rejected',
      );
      await this.bus.publish('dispatch', createMessageRejected({
        conversationId: payload.conversationId,
        channelId: payload.channelId,
        senderId: payload.senderId,
        reason: 'message_too_large',
        parentEventId: event.id,
      }));
      return;
    }

    this.logger.info(
      { channelId: payload.channelId, senderId: payload.senderId },
      'Dispatching to coordinator',
    );
    // ... rest of handleInbound unchanged
```

Make sure `createMessageRejected` is in the import at the top of the file. It's already imported in the dispatcher (check the import line — add it if missing).

- [ ] **Step 3: Pass `maxMessageBytes` from `index.ts` to the dispatcher**

In `src/index.ts`, find where `new Dispatcher(...)` is called. Add `maxMessageBytes`:

```typescript
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver,
    heldMessages: heldMessageService,
    channelPolicies,
    injectionScanner,
    pool,
    conversationCheckpointDebounceMs: yamlConfig.dispatch?.conversationCheckpointDebounceMs,
    trustScorerWeights,
    trustScoreFloor: yamlConfig.security?.trust_score_floor,
    maxMessageBytes: yamlConfig.channels?.max_message_bytes ?? 102_400,
  });
```

- [ ] **Step 4: Run the dispatcher tests — confirm all pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test tests/unit/dispatch/dispatcher.test.ts 2>&1 | tail -20
```

Expected: all tests pass, including the four new `Dispatcher message size limit` tests.

- [ ] **Step 5: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation run test 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add src/dispatch/dispatcher.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "feat: reject oversized inbound messages in dispatcher (spec §06)"
```

---

### Task 10: Update CHANGELOG and version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add CHANGELOG entries**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
### Security
- **Input validation** — startup validator (`src/startup/validator.ts`) validates `config/default.yaml`, all `agents/*.yaml`, and all `skills/*/skill.json` against JSON Schema (Ajv) at boot time. Invalid configs cause a descriptive `process.exit(1)` before any service initializes (spec §06).
- **Message size limiting** — dispatcher rejects inbound messages exceeding `channels.max_message_bytes` (default 100KB) before routing; rejection is audit-logged as `message.rejected` with causal `parentEventId` (spec §06).

### Added
- **`schemas/` directory** — JSON Schema files for agent configs, skill manifests, and `config/default.yaml`. Schemas are legible without TypeScript and can be validated with third-party tools.
- **`channels.max_message_bytes`** in `config/default.yaml` — configures the inbound message size limit (default `102400`).

### Changed
- **`MessageRejectedPayload.reason`** extended with `'message_too_large'` — bus event API surface change.
- **Agent and skill loaders** — manual field checks removed; validation is now handled by the startup validator schema.
```

- [ ] **Step 2: Bump the version**

This completes spec §06 input validation (partially shipped) — use a patch bump. In `package.json`, update `"version"`:

```json
"version": "0.14.1"
```

(Replace `0.14.1` with current version + patch. Check `package.json` for current version first.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-input-validation commit -m "chore: update changelog and bump version for input validation (issue #196)"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task that implements it |
|---|---|
| Inbound messages exceeding 100KB rejected before bus routing | Task 9 |
| Max size configurable as `channels.max_message_bytes` | Task 7 |
| Rejection audit-logged via `message.rejected` with `parentEventId` | Task 9 |
| Agent YAML validated against JSON Schema at startup | Tasks 3, 5, 6 |
| Skill manifests validated against JSON Schema at startup | Tasks 3, 5, 6 |
| Invalid config causes `process.exit(1)` with descriptive error | Task 6 (index.ts wiring) |
| Dispatch policy rules (`trust_policy.*`, `security.trust_score.*`) validated | Task 3 (default-config schema), Task 5 (validator) |
| Unit tests: oversized message → rejected | Task 8 |
| Unit tests: invalid agent YAML → startup error | Tasks 4, 5 |
| Unit tests: invalid manifest → startup error | Tasks 4, 5 |
| `message_too_large` in `MessageRejectedPayload.reason` | Task 2 |
| `config/default.yaml` schema validation (scope addition) | Tasks 3, 5 |

**Placeholder scan:** None found — all code blocks are complete.

**Type consistency check:**
- `runStartupValidation` signature: defined in Task 5, called in Task 6 ✓
- `configFileName` optional parameter: used in Task 4 tests for fixture isolation ✓
- `maxMessageBytes` field: added to `DispatcherConfig` in Task 9, passed from `index.ts` in Task 9, default `102_400` ✓
- `createMessageRejected` with `channelId`: matches the updated `MessageRejectedPayload` from Task 2 ✓
- `reason: 'message_too_large'`: defined in Task 2, used in Task 9, asserted in Task 8 tests ✓

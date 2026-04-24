# Per-Capability Skill Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the all-or-nothing `infrastructure: true` manifest flag with per-capability `capabilities` arrays — validated at load time, frozen after load, and enforced in the execution layer.

**Architecture:** Skills declare needed privileged services in `skill.json` as `"capabilities": ["outboundGateway"]`. The loader validates against a fixed allowlist and freezes the manifest. ExecutionLayer injects only the declared services, replacing the infrastructure block and all name-gated conditionals with a single loop.

**Tech Stack:** TypeScript, Vitest, pino

**Spec:** `docs/wip/2026-04-24-capability-registry-design.md`

---

### Task 1: Update SkillManifest type

**Files:**
- Modify: `src/skills/types.ts:31-69` (SkillManifest interface)
- Modify: `src/skills/types.ts:105-173` (SkillContext interface doc comments)

- [ ] **Step 1: Replace `infrastructure` with `capabilities` on SkillManifest**

In `src/skills/types.ts`, replace the `infrastructure` field:

```typescript
  /** If true, this skill receives bus and agent registry access in its context.
   *  This grants unrestricted bus publish/subscribe including layer impersonation.
   *  Only for framework-internal skills like 'delegate' — external skills should never set this. */
  infrastructure?: boolean;
```

with:

```typescript
  /** Declares which privileged SkillContext services this skill needs.
   *  Only known capability names are accepted — the loader validates against
   *  a fixed allowlist at startup and rejects unknown names.
   *  The manifest is frozen after loading — capabilities cannot be mutated at runtime.
   *
   *  Valid capabilities: bus, agentRegistry, outboundGateway, heldMessages,
   *  schedulerService, entityMemory, nylasCalendarClient, autonomyService,
   *  browserService, bullpenService, skillSearch.
   *
   *  Services NOT listed here (contactService, entityContextAssembler, agentPersona)
   *  are universal — available to every skill without declaration. */
  capabilities?: string[];
```

- [ ] **Step 2: Update SkillContext doc comments**

In the same file, update the doc comments on capability-gated fields. Replace every
occurrence of "only available to infrastructure skills" or similar with the specific
capability name. For example, on `bus`:

```typescript
  /** Bus access — available to skills declaring 'bus' in capabilities */
  bus?: import('../bus/bus.js').EventBus;
```

Apply the same pattern to: `agentRegistry`, `outboundGateway`, `heldMessages`,
`schedulerService`, `entityMemory`, `nylasCalendarClient`, `bullpenService`,
`autonomyService`, `browserService`, `skillSearch`.

For `browserService`, also remove the incorrect claim "available to all skills
(not infrastructure-gated)" since it IS capability-gated now.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --prefix <worktree> run typecheck`

Expected: Type errors in `execution.ts` (references `manifest.infrastructure`
which no longer exists) and possibly `loader.ts`. This is expected — we fix
those in Tasks 2 and 3.

- [ ] **Step 4: Commit**

```
git add src/skills/types.ts
git commit -m "feat: replace infrastructure boolean with capabilities array on SkillManifest (#119)"
```

---

### Task 2: Add loader validation and manifest freeze

**Files:**
- Modify: `src/skills/loader.ts:1-103`
- Create: `src/skills/loader.test.ts`

- [ ] **Step 1: Write failing tests for loader validation**

Create `src/skills/loader.test.ts`:

```typescript
// loader.test.ts — tests for capability validation and manifest freeze.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSkillsFromDirectory } from './loader.js';
import { SkillRegistry } from './registry.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Helper: create a temporary skill directory with a manifest and a trivial handler
function setupSkillDir(tmpDir: string, skillName: string, manifest: Record<string, unknown>): void {
  const skillDir = path.join(tmpDir, skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(manifest));
  // Minimal handler that exports a class with execute()
  fs.writeFileSync(path.join(skillDir, 'handler.ts'), `
    export class Handler {
      async execute(ctx) { return { success: true, data: 'ok' }; }
    }
  `);
}

describe('loader: capability validation', () => {
  it('rejects unknown capability names at load time', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_skills_unknown_cap__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'bad-skill', {
        name: 'bad-skill',
        description: 'test',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['outboundGateway', 'notARealCapability'],
      });
      const registry = new SkillRegistry();
      await expect(loadSkillsFromDirectory(tmpDir, registry, logger))
        .rejects.toThrow(/unknown capability.*notARealCapability/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts valid capability names', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_skills_valid_cap__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'good-skill', {
        name: 'good-skill',
        description: 'test',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['outboundGateway', 'entityMemory'],
      });
      const registry = new SkillRegistry();
      const count = await loadSkillsFromDirectory(tmpDir, registry, logger);
      expect(count).toBe(1);
      const skill = registry.get('good-skill');
      expect(skill?.manifest.capabilities).toEqual(['outboundGateway', 'entityMemory']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts skills with no capabilities field', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_skills_no_cap__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'simple-skill', {
        name: 'simple-skill',
        description: 'test',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
      });
      const registry = new SkillRegistry();
      const count = await loadSkillsFromDirectory(tmpDir, registry, logger);
      expect(count).toBe(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('loader: manifest freeze', () => {
  it('freezes the manifest after loading', async () => {
    const tmpDir = path.join(import.meta.dirname, '__test_skills_freeze__');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      setupSkillDir(tmpDir, 'frozen-skill', {
        name: 'frozen-skill',
        description: 'test',
        version: '1.0.0',
        action_risk: 'none',
        inputs: {},
        outputs: {},
        capabilities: ['entityMemory'],
      });
      const registry = new SkillRegistry();
      await loadSkillsFromDirectory(tmpDir, registry, logger);
      const skill = registry.get('frozen-skill');
      expect(Object.isFrozen(skill?.manifest)).toBe(true);
      // Attempting to mutate should throw in strict mode or silently fail
      expect(() => { (skill!.manifest as Record<string, unknown>).capabilities = ['bus']; }).toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --prefix <worktree> test src/skills/loader.test.ts`

Expected: Tests fail because validation and freeze aren't implemented yet.

- [ ] **Step 3: Implement loader validation and freeze**

In `src/skills/loader.ts`, add the `VALID_CAPABILITIES` set near the top (after imports):

```typescript
/**
 * Fixed allowlist of valid capability names that skills may declare.
 * Each name corresponds to a privileged service on SkillContext.
 * This set only changes when a new service type is added to the platform —
 * not when a new skill is added.
 */
export const VALID_CAPABILITIES: ReadonlySet<string> = new Set([
  'bus', 'agentRegistry', 'outboundGateway', 'heldMessages',
  'schedulerService', 'entityMemory', 'nylasCalendarClient',
  'autonomyService', 'browserService', 'bullpenService', 'skillSearch',
]);
```

Then after the existing default-setting block (`manifest.timeout ??= 30000;`
etc.), add:

```typescript
      // Default capabilities to empty array
      manifest.capabilities ??= [];

      // Validate declared capabilities against the allowlist.
      // Unknown names fail hard at startup — not silently ignored.
      for (const cap of manifest.capabilities) {
        if (!VALID_CAPABILITIES.has(cap)) {
          throw new Error(
            `Skill '${manifest.name}' declares unknown capability '${cap}'. ` +
            `Valid capabilities: ${[...VALID_CAPABILITIES].join(', ')}`,
          );
        }
      }
```

Then, right before `registry.register(manifest, handler)`, freeze the manifest:

```typescript
      // Freeze the manifest to prevent runtime mutation — a handler cannot
      // escalate its own privileges by pushing to capabilities[].
      Object.freeze(manifest);
      if (manifest.capabilities) Object.freeze(manifest.capabilities);
```

Note: `Object.freeze` is shallow — we need to freeze the `capabilities` array
separately to prevent `manifest.capabilities.push('bus')`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --prefix <worktree> test src/skills/loader.test.ts`

Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```
git add src/skills/loader.ts src/skills/loader.test.ts
git commit -m "feat: add capability validation and manifest freeze to skill loader (#119)"
```

---

### Task 3: Rewrite ExecutionLayer capability injection

**Files:**
- Modify: `src/skills/execution.ts:277-354` (infrastructure block + name-gated conditionals)
- Modify: `src/skills/execution.ts:1-19` (file header comment)
- Modify: `src/skills/execution.test.ts`

- [ ] **Step 1: Write failing tests for capability injection**

Add these test cases to `src/skills/execution.test.ts`:

```typescript
import type { EventBus } from '../bus/bus.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { OutboundGateway } from './outbound-gateway.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';

// ---------------------------------------------------------------------------
// Capability-gated service injection
// ---------------------------------------------------------------------------

describe('capability-gated service injection', () => {
  /** Manifest that declares a specific capability. */
  function makeCapManifest(name: string, capabilities: string[]): SkillManifest {
    return {
      name,
      description: `${name} description`,
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'none',
      inputs: {},
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
      capabilities,
    };
  }

  it('injects only declared capabilities into context', async () => {
    const registry = new SkillRegistry();
    // Handler captures the context it received so we can inspect it
    let capturedCtx: Record<string, unknown> = {};
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx) => {
        capturedCtx = ctx as unknown as Record<string, unknown>;
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeCapManifest('outbound-only', ['outboundGateway']), handler);

    const mockGateway = { send: vi.fn() } as unknown as OutboundGateway;
    const mockBus = { publish: vi.fn() } as unknown as EventBus;
    const mockScheduler = { createJob: vi.fn() } as unknown as SchedulerService;

    const layer = new ExecutionLayer(registry, logger, {
      outboundGateway: mockGateway,
      bus: mockBus,
      schedulerService: mockScheduler,
    });

    await layer.invoke('outbound-only', {});

    // Should have outboundGateway
    expect(capturedCtx.outboundGateway).toBe(mockGateway);
    // Should NOT have bus or schedulerService — not declared
    expect(capturedCtx.bus).toBeUndefined();
    expect(capturedCtx.schedulerService).toBeUndefined();
  });

  it('injects no privileged services when capabilities is empty', async () => {
    const registry = new SkillRegistry();
    let capturedCtx: Record<string, unknown> = {};
    const handler: SkillHandler = {
      execute: vi.fn(async (ctx) => {
        capturedCtx = ctx as unknown as Record<string, unknown>;
        return { success: true, data: 'ok' };
      }),
    };
    registry.register(makeCapManifest('no-caps', []), handler);

    const mockBus = { publish: vi.fn() } as unknown as EventBus;
    const mockGateway = { send: vi.fn() } as unknown as OutboundGateway;

    const layer = new ExecutionLayer(registry, logger, {
      bus: mockBus,
      outboundGateway: mockGateway,
    });

    await layer.invoke('no-caps', {});

    expect(capturedCtx.bus).toBeUndefined();
    expect(capturedCtx.outboundGateway).toBeUndefined();
    // Universal services should still be present if configured
    // (contactService, entityContextAssembler, agentPersona)
  });

  it('returns skill error when declared capability is not available', async () => {
    const registry = new SkillRegistry();
    const handler: SkillHandler = {
      execute: vi.fn(async () => ({ success: true, data: 'ok' })),
    };
    registry.register(makeCapManifest('needs-scheduler', ['schedulerService']), handler);

    // ExecutionLayer constructed WITHOUT schedulerService
    const layer = new ExecutionLayer(registry, logger);

    const result = await layer.invoke('needs-scheduler', {});

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
    // Handler should NOT have been called
    expect(handler.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --prefix <worktree> test src/skills/execution.test.ts`

Expected: Tests fail because the infrastructure block doesn't read `capabilities`.

- [ ] **Step 3: Rewrite the capability injection in ExecutionLayer.invoke()**

In `src/skills/execution.ts`, replace the entire block from:
```typescript
    // Infrastructure skills get bus and agent registry access.
    // This is intentionally gated behind a manifest flag so normal skills
    // cannot escalate their privileges by accessing the bus directly.
    if (manifest.infrastructure) {
```
through to the closing `}` of the infrastructure block (around line 328),
AND remove the three separate name-gated conditionals for `autonomyService`
(lines 330-334), `browserService` (lines 336-342), and `skillSearch`
(lines 344-354).

Replace all of that with:

```typescript
    // Capability-gated service injection.
    // Skills declare which privileged services they need in manifest.capabilities.
    // The loader validates the names and freezes the manifest at startup.
    // We inject only the declared services — skills cannot escalate privilege.
    const caps = manifest.capabilities ?? [];

    // Fail-closed: if a declared capability is not available on this ExecutionLayer,
    // refuse to run the skill. This catches configuration errors at invocation time.
    const missingCaps = caps.filter(cap => {
      if (cap === 'skillSearch') return false; // skillSearch is synthesised, not a field on `this`
      return !(this as Record<string, unknown>)[cap];
    });
    if (missingCaps.length > 0) {
      skillLogger.error(
        { skillName, missingCapabilities: missingCaps },
        'Skill declares capabilities not available on ExecutionLayer',
      );
      return {
        success: false,
        error: this.wrapSkillError(
          `Skill '${skillName}' requires capabilities [${missingCaps.join(', ')}] ` +
          `but they are not configured on the ExecutionLayer`,
        ),
      };
    }

    // Compute audit context for entityMemory observer (before the loop — used inside it).
    const memAudit = options?.agentId && options?.conversationId && options?.parentEventId
      ? { agentId: options.agentId, conversationId: options.conversationId, parentEventId: options.parentEventId, taskEventId: options.taskEventId }
      : undefined;

    for (const cap of caps) {
      if (cap === 'entityMemory') {
        // Special case: wrap with audit observer when audit context is available.
        // Uses this.bus (ExecutionLayer's bus), not the skill's ctx.bus — the observer
        // needs bus access for audit events even if the skill didn't declare 'bus'.
        ctx.entityMemory = memAudit && this.bus
          ? buildEntityMemoryObserver(this.entityMemory!, this.bus, memAudit, skillLogger)
          : this.entityMemory;
      } else if (cap === 'skillSearch') {
        // Special case: skillSearch is a closure over the registry, not a service field.
        ctx.skillSearch = (query: string) =>
          this.registry.search(query)
            .filter(s => s.manifest.name !== 'skill-registry')
            .map(s => ({ name: s.manifest.name, description: s.manifest.description }));
      } else {
        (ctx as Record<string, unknown>)[cap] = (this as Record<string, unknown>)[cap];
      }
    }
```

- [ ] **Step 4: Update the file header comment**

Replace the existing header comment (lines 1-18) with:

```typescript
// execution.ts — the execution layer runs skills within controlled boundaries.
//
// This is the security boundary between agents and the outside world.
// It resolves skills from the registry, validates permissions, provides
// a sandboxed SkillContext, enforces timeouts, and sanitizes outputs.
//
// Normal skills get: validated input, scoped secret access, a scoped logger,
// and universal services (contactService, entityContextAssembler, agentPersona).
//
// Privileged services (bus, outboundGateway, entityMemory, etc.) are only
// injected when the skill declares them in manifest.capabilities[]. The loader
// validates capability names against a fixed allowlist and freezes the manifest
// at startup — skills cannot self-escalate at runtime.
//
// Entity enrichment (manifest.entity_enrichment): when a skill declares this,
// the execution layer assembles EntityContext for the declared input parameter
// before invoking the handler. The handler receives ctx.entityContext[] and
// never needs to call entity-context itself.
```

- [ ] **Step 5: Run all tests**

Run: `pnpm --prefix <worktree> test src/skills/execution.test.ts`

Expected: All tests pass (existing + 3 new).

- [ ] **Step 6: Run typecheck**

Run: `pnpm --prefix <worktree> run typecheck`

Expected: Clean. The `infrastructure` field is removed from the type and all
code references have been updated.

- [ ] **Step 7: Commit**

```
git add src/skills/execution.ts src/skills/execution.test.ts
git commit -m "feat: replace infrastructure block with per-capability injection loop (#119)"
```

---

### Task 4: Migrate all 50 skill.json files

**Files:**
- Modify: all `skills/*/skill.json` that have `"infrastructure": true`

This task is mechanical — remove `"infrastructure": true` and add
`"capabilities": [...]` based on the verified audit.

- [ ] **Step 1: Migrate the 32 skills that NEED capabilities**

For each skill below, remove `"infrastructure": true` and add the
`"capabilities"` field with the listed values.

**outboundGateway:**
```
email-send:         ["outboundGateway"]
email-reply:        ["outboundGateway"]
email-get:          ["outboundGateway"]
email-list:         ["outboundGateway"]
email-archive:      ["outboundGateway"]
email-draft-save:   ["outboundGateway"]
signal-send:        ["outboundGateway"]
```

**heldMessages:**
```
held-messages-list:    ["heldMessages"]
held-messages-process: ["heldMessages", "bus"]
```

**schedulerService:**
```
scheduler-create:  ["schedulerService"]
scheduler-list:    ["schedulerService"]
scheduler-cancel:  ["schedulerService"]
scheduler-report:  ["schedulerService"]
```

**nylasCalendarClient:**
```
calendar-list-calendars:  ["nylasCalendarClient"]
calendar-list-events:     ["nylasCalendarClient"]
calendar-create-event:    ["nylasCalendarClient"]
calendar-update-event:    ["nylasCalendarClient"]
calendar-delete-event:    ["nylasCalendarClient"]
calendar-check-conflicts: ["nylasCalendarClient"]
calendar-find-free-time:  ["nylasCalendarClient"]
```

**entityMemory:**
```
extract-relationships:        ["entityMemory"]
query-relationships:          ["entityMemory"]
delete-relationship:          ["entityMemory"]
extract-facts:                ["entityMemory"]
context-for-email:            ["entityMemory"]
knowledge-meeting-links:      ["entityMemory"]
knowledge-loyalty-programs:   ["entityMemory"]
knowledge-travel-preferences: ["entityMemory"]
knowledge-company-overview:   ["entityMemory"]
```

**bus + agentRegistry / bullpenService:**
```
delegate: ["bus", "agentRegistry"]
bullpen:  ["bus", "bullpenService"]
```

**autonomyService / browserService / skillSearch:**
```
get-autonomy:    ["autonomyService"]
set-autonomy:    ["autonomyService"]
web-browser:     ["browserService"]
skill-registry:  ["skillSearch"]
```

- [ ] **Step 2: Migrate the 18 skills that need NO capabilities**

For each skill below, remove `"infrastructure": true` and do NOT add a
`capabilities` field (or add `"capabilities": []`):

```
contact-create, contact-list, contact-lookup, contact-merge,
contact-find-duplicates, contact-set-role, contact-link-identity,
contact-unlink-identity, contact-grant-permission, contact-revoke-permission,
contact-set-trust, contact-rename,
template-meeting-request, template-cancel, template-reschedule,
template-doc-request,
entity-context, calendar-register
```

- [ ] **Step 3: Verify no infrastructure references remain**

Run: `grep -r '"infrastructure"' skills/*/skill.json`

Expected: No output (all instances removed).

- [ ] **Step 4: Commit**

```
git add skills/*/skill.json
git commit -m "feat: migrate all 50 skill.json files from infrastructure to capabilities (#119)"
```

---

### Task 5: Update handler error messages

**Files:**
- Modify: handler.ts files that reference `infrastructure: true` in error messages

- [ ] **Step 1: Find all handler error messages referencing infrastructure**

Run: `grep -rn 'infrastructure' skills/*/handler.ts`

This will list every handler that mentions `infrastructure` in its error strings.

- [ ] **Step 2: Update each error message**

Replace messages like:
```
'email-get requires outboundGateway (infrastructure: true)'
```
with:
```
'email-get requires outboundGateway — declare it in capabilities'
```

Apply the same pattern to every handler found in Step 1. The specific capability
name should match what the skill actually needs.

- [ ] **Step 3: Commit**

```
git add skills/*/handler.ts
git commit -m "fix: update handler error messages to reference capabilities instead of infrastructure (#119)"
```

---

### Task 6: Update documentation

**Files:**
- Modify: `docs/dev/adding-a-skill.md`
- Modify: `docs/specs/03-skills-and-execution.md`

- [ ] **Step 1: Update adding-a-skill.md**

Replace the `infrastructure` field reference (the `#### \`infrastructure\`` section
around line 112-114) with:

```markdown
#### `capabilities` (optional, default: `[]`)

Declares which privileged `SkillContext` services this skill needs. The loader
validates names against a fixed allowlist at startup — unknown names cause a
hard load failure. The manifest is frozen after loading, so capabilities cannot
be mutated at runtime.

Valid capability names:

| Capability | Service | Use when your skill needs to... |
|---|---|---|
| `bus` | `EventBus` | Publish or subscribe to bus events |
| `agentRegistry` | `AgentRegistry` | Enumerate or target other agents |
| `outboundGateway` | `OutboundGateway` | Send email, Signal messages, or other outbound comms |
| `heldMessages` | `HeldMessageService` | List or process held/deferred messages |
| `schedulerService` | `SchedulerService` | Create, list, or cancel scheduled jobs |
| `entityMemory` | `EntityMemory` | Read or write to the knowledge graph |
| `nylasCalendarClient` | `NylasCalendarClient` | CRUD operations on calendar events |
| `autonomyService` | `AutonomyService` | Read or write the global autonomy score |
| `browserService` | `BrowserService` | Interact with a Playwright browser instance |
| `bullpenService` | `BullpenService` | Open or reply to inter-agent discussion threads |
| `skillSearch` | closure | Search the skill registry (skill-registry built-in only) |

Services NOT listed here are universal — available to every skill without declaration:
`contactService` (contact lookups), `entityContextAssembler` (entity context pipeline),
`agentPersona` (agent identity).

Most skills need zero or one capability. Only declare what your handler actually uses —
the execution layer will refuse to run a skill if a declared capability is not available.

Example:
```json
"capabilities": ["outboundGateway"]
```
```

Update the `SkillContext` example (around lines 239-266) — replace the
"Infrastructure-only fields" comment with "Capability-gated fields (declared in
manifest capabilities)".

Add to the PR checklist:
```markdown
- [ ] If the skill needs privileged services, declare them in `"capabilities"`
```

- [ ] **Step 2: Update 03-skills-and-execution.md**

Replace the "Privilege access" paragraph (line 42):

```markdown
**Privilege access** — skills declare which privileged services they need via `"capabilities"` in `skill.json`. The loader validates names against a fixed allowlist at startup and freezes the manifest. The execution layer injects only declared services — skills cannot self-escalate. Universal services (`contactService`, `entityContextAssembler`, `agentPersona`) are available to all skills without declaration.
```

Update the implementation status entry (line 222):

```markdown
| Privilege scoping — per-skill capability declarations replacing `infrastructure` self-declaration | Done — `capabilities` array in `skill.json`, validated at load, frozen after load; closes #119 |
```

- [ ] **Step 3: Commit**

```
git add docs/dev/adding-a-skill.md docs/specs/03-skills-and-execution.md
git commit -m "docs: update skill guides for capabilities system (#119)"
```

---

### Task 7: Version bump, changelog, and full test suite

**Files:**
- Modify: `package.json` (version)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump version**

In `package.json`, change `"version": "0.19.7"` to `"version": "0.19.8"`.

- [ ] **Step 2: Add changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add:

```markdown
## [0.19.8] — 2026-04-XX

### Security

- **Per-capability skill privileges** — replaced the all-or-nothing `infrastructure: true` manifest flag with a `capabilities` array. Skills declare exactly which privileged services they need; the loader validates against a fixed allowlist and freezes the manifest at startup. 18 skills that only used universal services lost unnecessary privilege access entirely. Closes #119.

### Changed

- **Skill manifest schema** (breaking) — `infrastructure?: boolean` removed, replaced by `capabilities?: string[]`. The loader rejects unknown capability names at startup. Manifests are frozen after loading to prevent runtime mutation.
```

- [ ] **Step 3: Run the full test suite**

Run: `pnpm --prefix <worktree> test`

Expected: All tests pass.

- [ ] **Step 4: Run typecheck**

Run: `pnpm --prefix <worktree> run typecheck`

Expected: Clean.

- [ ] **Step 5: Commit**

```
git add package.json CHANGELOG.md
git commit -m "chore: bump to 0.19.8, changelog for per-capability privileges (#119)"
```

---

### Task 8: Pre-PR review and PR creation

- [ ] **Step 1: Run pre-PR review agents**

Launch in parallel:
- `pr-review-toolkit:code-reviewer` — review all changes on branch vs base
- `pr-review-toolkit:silent-failure-hunter` — check for swallowed errors

Since this touches the security boundary, also run a security review.

- [ ] **Step 2: Address any findings**

Fix high-priority issues from the reviews. Commit fixes.

- [ ] **Step 3: Create the PR**

```
gh pr create --title "security: replace infrastructure flag with per-capability skill privileges" \
  --body "..." --label bug --label P2 --label security
```

Reference issue #119. Include the summary:
- Replaced `infrastructure: true` (all-or-nothing) with `capabilities` array
- Load-time validation + manifest freeze prevents runtime escalation
- 18 skills lost unnecessary privilege access
- 32 skills now declare only the specific services they use

- [ ] **Step 4: Verify CI started**

Run: `gh run list --branch fix/capability-registry --limit 1`

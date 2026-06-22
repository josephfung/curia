# setup-wizard v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the setup-wizard agent into a resumable, value-first concierge by adding a catalog-driven `setup-status` skill, a `setup-defer` write skill, and a rewritten agent prompt.

**Architecture:** The wizard owns a `catalog.yaml` inside the `setup-status` skill bundle. `setup-status` reads the catalog and derives each task's status from live system state (vault key presence, scheduler jobs, behavioral preferences). `setup-defer` persists/clears deferral flags in config-store. The agent's v2 prompt drives an outcome-backward flow using both skills, routing credential entry to the console (email, Signal) or to in-chat capture (Tavily, OpenAI). curia-docs gets new/updated pages for each credentialed task. CLAUDE.md gets a coaching note to keep the catalog current.

**Tech Stack:** TypeScript/ESM, Node 24+, js-yaml, Vitest, pnpm workspace, Postgres (integration tests require real DB via Docker container `curia-test-pg` on port 5433).

**Repos:**
- `worktrees/curia-setup-wizard-v2` — main feature branch `feat/setup-wizard-v2` (Tasks 1–4)
- A separate `curia-docs` worktree to be created by the implementer (Task 5)

## Global Constraints

- ESM only: `.js` extensions on all relative imports; `import.meta.dirname` not `__dirname`
- No `any` — use discriminated unions and proper types
- `ctx.secret(name)` throws when a declared secret is not in vault or env (use try-catch to check presence)
- All skill manifests require `action_risk` — omitting it fails startup validation
- Parameterized SQL only — never string-interpolate values into queries
- Timestamps shown to users: `toLocalIso()` from `src/time/timestamp.ts` with `ctx.timezone`
- Run `pnpm -C <worktree> run typecheck` before every commit touching `.ts` files (CI uses pnpm typecheck, not raw tsc)
- All new WIP artifacts go in `docs/wip/`, not `docs/superpowers/` or `docs/plans/`
- Skill version starts at `"0.1.0"`; bump `minor` for new capability, `patch` for fix
- `setup-status` and `setup-defer` must both be pinned in `agents/setup-wizard.yaml` before the agent can use them

---

## File Map

### New files — `worktrees/curia-setup-wizard-v2`
| File | Purpose |
|---|---|
| `skills/setup-defer/skill.json` | Manifest: action_risk low, entityMemory capability |
| `skills/setup-defer/handler.ts` | Reads/writes setup_wizard/deferrals in config-store |
| `skills/setup-defer/handler.test.ts` | Unit tests for defer/resume logic |
| `skills/setup-status/skill.json` | Manifest: action_risk none, multi-capability |
| `skills/setup-status/catalog.yaml` | Declarative catalog — owned by this skill, not core |
| `skills/setup-status/handler.ts` | Reads catalog, derives status per task from live state |
| `skills/setup-status/handler.test.ts` | Unit tests for each completion_check type |

### Modified files — `worktrees/curia-setup-wizard-v2`
| File | Change |
|---|---|
| `agents/setup-wizard.yaml` | Bump to v0.2.0, add `setup-status` + `setup-defer` to pinned_skills, rewrite system_prompt |
| `CLAUDE.md` | Add "Setup wizard — keep the catalog current" note in "Adding Things" |
| `CHANGELOG.md` | Add unreleased entries for catalog, two skills, and v2 prompt |

### New/modified files — `repos/curia-docs` (separate worktree, Task 5)
| File | Change |
|---|---|
| `channels/email-setup.mdx` | Add console credential entry section alongside env-var instructions |
| `channels/signal-setup.mdx` | Add console credential entry section for socket path + phone |
| `integrations/tavily.mdx` | New — Tavily API key setup |
| `integrations/openai-embeddings.mdx` | New — OpenAI embeddings key setup |
| `docs.json` | Add `integrations/` group with the two new pages |

---

## Task 1: `setup-defer` skill

Writes/clears deferral flags in config-store. A deferred task's id is stored as a JSON array under `setup_wizard/deferrals`. Rewriting the whole array on each call sidesteps config-store's no-delete limitation.

**Files:**
- Create: `skills/setup-defer/skill.json`
- Create: `skills/setup-defer/handler.ts`
- Create: `skills/setup-defer/handler.test.ts`

**Interfaces:**
- Produces: consumed by `setup-status` (reads same namespace/key); also referenced by the agent prompt

- [ ] **Step 1: Write the failing test**

  ```typescript
  // skills/setup-defer/handler.test.ts
  import { describe, it, expect, vi } from 'vitest';
  import { SetupDeferHandler } from './handler.js';
  import type { SkillContext } from '../../src/skills/types.js';

  // Minimal ConfigStore double — mirrors real get/set contract
  function makeEntityMemory(initial: Record<string, string> = {}) {
    const store: Record<string, string> = { ...initial };
    return {
      // ConfigStore constructor only needs storeFact + recallFacts
      storeFact: vi.fn(async (fact: { subject: string; predicate: string; object: string }) => {
        store[`${fact.subject}::${fact.predicate}`] = fact.object;
        return { stored: true };
      }),
      recallFacts: vi.fn(async (query: { subject?: string; predicate?: string }) => {
        const key = `${query.subject ?? ''}::${query.predicate ?? ''}`;
        if (store[key] !== undefined) {
          return [{ object: store[key] }];
        }
        return [];
      }),
    };
  }

  function makeCtx(input: Record<string, unknown>, storeData: Record<string, string> = {}): SkillContext {
    return {
      input,
      entityMemory: makeEntityMemory(storeData) as unknown as SkillContext['entityMemory'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SkillContext['log'],
      secret: vi.fn(),
    } as unknown as SkillContext;
  }

  const handler = new SetupDeferHandler();

  describe('setup-defer', () => {
    it('defers a task that was not deferred', async () => {
      const ctx = makeCtx({ task_id: 'email', action: 'defer' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect((result as { success: true; data: { deferred: string[] } }).data.deferred).toEqual(['email']);
    });

    it('defers a task only once (idempotent)', async () => {
      // Pre-seed with 'email' already deferred
      const existing = JSON.stringify(['email']);
      // ConfigStore uses subject='config:setup_wizard', predicate='deferrals'
      const storeData = { 'config:setup_wizard::deferrals': existing };
      const ctx = makeCtx({ task_id: 'email', action: 'defer' }, storeData);
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { deferred: string[] } }).data;
      expect(data.deferred).toEqual(['email']); // no duplicate
    });

    it('resumes a deferred task', async () => {
      const existing = JSON.stringify(['email', 'signal']);
      const storeData = { 'config:setup_wizard::deferrals': existing };
      const ctx = makeCtx({ task_id: 'email', action: 'resume' }, storeData);
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      const data = (result as { success: true; data: { deferred: string[] } }).data;
      expect(data.deferred).toEqual(['signal']);
    });

    it('returns error when task_id is missing', async () => {
      const ctx = makeCtx({ action: 'defer' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('returns error when action is invalid', async () => {
      const ctx = makeCtx({ task_id: 'email', action: 'snooze' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('returns error when entityMemory is absent', async () => {
      const ctx = { input: { task_id: 'email', action: 'defer' }, log: { error: vi.fn() } } as unknown as SkillContext;
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run test skills/setup-defer/handler.test.ts 2>&1 | tail -20
  ```
  Expected: FAIL with "Cannot find module './handler.js'"

- [ ] **Step 3: Write `skill.json`**

  ```json
  {
    "name": "setup-defer",
    "description": "Record or clear a setup-wizard task deferral. Use when the principal says they want to skip a setup task for now. Deferred tasks resurface as 'pending (deferred)' on the next setup-status call — never as done. Use action 'resume' to clear a deferral when the principal is ready to tackle it.",
    "version": "0.1.0",
    "sensitivity": "normal",
    "action_risk": "low",
    "inputs": {
      "task_id": "string (catalog task id, e.g. 'email', 'signal', 'web_research', 'kg_memory', 'persona', 'debrief')",
      "action": "string ('defer' to skip a task, 'resume' to un-skip it)"
    },
    "outputs": {
      "task_id": "string",
      "action": "string",
      "deferred": "string[] (full updated list of deferred task ids after this operation)",
      "summary": "string"
    },
    "permissions": [],
    "secrets": [],
    "timeout": 15000,
    "capabilities": ["entityMemory"],
    "allowed_callers": ["setup-wizard"]
  }
  ```

- [ ] **Step 4: Write `handler.ts`**

  ```typescript
  // skills/setup-defer/handler.ts
  import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
  import { ConfigStore } from '../../src/memory/config-store.js';

  const NAMESPACE = 'setup_wizard';
  const KEY = 'deferrals';

  export class SetupDeferHandler implements SkillHandler {
    async execute(ctx: SkillContext): Promise<SkillResult> {
      if (!ctx.entityMemory) {
        return { success: false, error: 'setup-defer requires entityMemory capability.' };
      }

      const { task_id, action } = ctx.input as { task_id?: unknown; action?: unknown };

      if (typeof task_id !== 'string' || !task_id.trim()) {
        return { success: false, error: 'task_id must be a non-empty string.' };
      }
      if (action !== 'defer' && action !== 'resume') {
        return { success: false, error: 'action must be "defer" or "resume".' };
      }

      const configStore = new ConfigStore(ctx.entityMemory, ctx.log);

      try {
        const stored = await configStore.get(NAMESPACE, KEY);
        let deferred: string[] = [];
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as unknown;
            deferred = Array.isArray(parsed)
              ? parsed.filter((x): x is string => typeof x === 'string')
              : [];
          } catch {
            ctx.log.warn({ stored }, 'setup-defer: deferrals value was not valid JSON — resetting to empty');
          }
        }

        if (action === 'defer') {
          if (!deferred.includes(task_id)) {
            deferred = [...deferred, task_id];
          }
        } else {
          deferred = deferred.filter(id => id !== task_id);
        }

        await configStore.set(NAMESPACE, KEY, JSON.stringify(deferred));

        return {
          success: true,
          data: {
            task_id,
            action,
            deferred,
            summary:
              action === 'defer'
                ? `"${task_id}" deferred. ${deferred.length} task(s) deferred total.`
                : `"${task_id}" removed from deferrals. ${deferred.length} task(s) deferred remaining.`,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err }, 'setup-defer failed');
        return { success: false, error: message };
      }
    }
  }
  ```

- [ ] **Step 5: Run test to confirm it passes**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run test skills/setup-defer/handler.test.ts 2>&1 | tail -20
  ```
  Expected: all 6 tests PASS

  If tests fail because ConfigStore's internal KG storage key format differs from the mock, read `src/memory/config-store.ts` lines 1–123 to verify the exact `storeFact` call shape and adjust the `storeData` seed in tests accordingly.

- [ ] **Step 6: Typecheck**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run typecheck 2>&1 | tail -20
  ```
  Expected: no errors

- [ ] **Step 7: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 add skills/setup-defer/skill.json skills/setup-defer/handler.ts skills/setup-defer/handler.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 commit -m "feat(skills): add setup-defer skill for wizard task deferral"
  ```

---

## Task 2: `setup-status` skill + catalog

Reads a YAML catalog bundled with the skill and derives each task's live status. No stored progress — status comes from vault key checks, scheduler state, and behavioral preferences.

**Files:**
- Create: `skills/setup-status/catalog.yaml`
- Create: `skills/setup-status/skill.json`
- Create: `skills/setup-status/handler.ts`
- Create: `skills/setup-status/handler.test.ts`

**Interfaces:**
- Consumes: `ctx.secret(key)` (vault key presence), `ctx.schedulerService.listJobs()`, `ctx.officeIdentityService.get()`, ConfigStore `setup_wizard/deferrals` (same key as `setup-defer`)
- Produces: `{ tasks: CatalogTaskWithStatus[], summary: { total, done, pending, deferred } }`

- [ ] **Step 1: Create `catalog.yaml`**

  ```yaml
  # skills/setup-status/catalog.yaml
  # Setup-wizard task catalog. Owned here — not a core module.
  # Each completion_check type is implemented in handler.ts.
  tasks:
    - id: persona
      label: "Assistant persona & preferences"
      value_prop: "Tune tone, working style, and behavioral guidelines — takes one conversation turn, no credentials."
      tier: instant
      handoff: in-chat
      completion_check:
        type: behavioral_preferences
      credential_how_to: null
      docs_url: null

    - id: debrief
      label: "Scheduled debrief"
      value_prop: "Regular digest at end of day or end of week — takes one conversation turn, no credentials."
      tier: instant
      handoff: in-chat
      completion_check:
        type: scheduler_has_active_debrief
      credential_how_to: null
      docs_url: null

    - id: capability_tour
      label: "Capability tour"
      value_prop: "See what is ready to use right now — zero setup needed."
      tier: instant
      handoff: in-chat
      completion_check:
        type: always_available
      credential_how_to: null
      docs_url: null

    - id: email
      label: "Email (Nylas)"
      value_prop: "Lets Curia read, draft, and send email on your behalf — unlocks ceo-inbox."
      tier: heavy
      handoff: console
      handoff_path: /settings/channels
      completion_check:
        type: vault_secrets_all
        keys:
          - channel.email.nylas_api_key
          - channel.email.nylas_grant_id
      credential_how_to: "Get your Nylas API key and grant ID at app.nylas.com (free tier works). Enter them in Settings → Channels → Email."
      docs_url: /channels/email-setup

    - id: signal
      label: "Signal"
      value_prop: "Private, end-to-end encrypted messaging — Curia's highest-trust channel."
      tier: medium
      handoff: console
      handoff_path: /settings/channels
      completion_check:
        type: vault_secrets_all
        keys:
          - channel.signal.socket_path
          - channel.signal.phone_number
      credential_how_to: "Set up signal-cli (included in docker-compose.yml), then enter the socket path and your phone number in Settings → Channels → Signal."
      docs_url: /channels/signal-setup

    - id: web_research
      label: "Web research (Tavily)"
      value_prop: "Live web search for research tasks and news monitoring."
      tier: one-key
      handoff: in-chat
      completion_check:
        type: vault_secrets_all
        keys:
          - user.tavily_api_key
      credential_how_to: "Get a free API key at tavily.com. I'll send you a secure link to enter it."
      docs_url: /integrations/tavily

    - id: kg_memory
      label: "KG entity memory (OpenAI embeddings)"
      value_prop: "Semantic relationship memory across people, projects, and context."
      tier: one-key
      handoff: in-chat
      optional: true
      completion_check:
        type: vault_secrets_all
        keys:
          - user.openai_api_key
      credential_how_to: "Get an OpenAI API key at platform.openai.com. I'll send you a secure link to enter it. This is optional — Curia works without it."
      docs_url: /integrations/openai-embeddings
  ```

- [ ] **Step 2: Write the failing test**

  ```typescript
  // skills/setup-status/handler.test.ts
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { SetupStatusHandler } from './handler.js';
  import type { SkillContext } from '../../src/skills/types.js';

  // Re-use the same ConfigStore-compatible entityMemory double from setup-defer tests
  function makeEntityMemory(storeData: Record<string, string> = {}) {
    const store: Record<string, string> = { ...storeData };
    return {
      storeFact: vi.fn(async (fact: { subject: string; predicate: string; object: string }) => {
        store[`${fact.subject}::${fact.predicate}`] = fact.object;
        return { stored: true };
      }),
      recallFacts: vi.fn(async (query: { subject?: string; predicate?: string }) => {
        const key = `${query.subject ?? ''}::${query.predicate ?? ''}`;
        return store[key] !== undefined ? [{ object: store[key] }] : [];
      }),
    };
  }

  function makeCtx(overrides: Partial<{
    secrets: Record<string, string>;
    storeData: Record<string, string>;
    behavioralPreferences: string[];
    activeJobs: Array<{ intentAnchor?: string }>;
  }> = {}): SkillContext {
    const secrets = overrides.secrets ?? {};
    return {
      input: {},
      entityMemory: makeEntityMemory(overrides.storeData) as unknown as SkillContext['entityMemory'],
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as SkillContext['log'],
      secret: vi.fn((name: string) => {
        if (secrets[name] !== undefined) return secrets[name];
        throw new Error(`Secret not found: ${name}`);
      }),
      officeIdentityService: {
        get: () => ({
          behavioralPreferences: overrides.behavioralPreferences ?? [],
          assistant: { name: 'Curia', title: '', emailSignature: '' },
          tone: { baseline: [], verbosity: 50, directness: 50 },
          decisionStyle: { externalActions: 'balanced', internalActions: 'balanced' },
          constraints: [],
        }),
      } as unknown as SkillContext['officeIdentityService'],
      schedulerService: {
        listJobs: vi.fn(async () => overrides.activeJobs ?? []),
      } as unknown as SkillContext['schedulerService'],
    } as unknown as SkillContext;
  }

  const handler = new SetupStatusHandler();

  describe('setup-status', () => {
    describe('completion checks', () => {
      it('persona: done when behavioralPreferences is non-empty', async () => {
        const ctx = makeCtx({ behavioralPreferences: ['prefers concise summaries'] });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const persona = data.tasks.find(t => t.id === 'persona');
        expect(persona?.status).toBe('done');
      });

      it('persona: pending when behavioralPreferences is empty', async () => {
        const ctx = makeCtx({ behavioralPreferences: [] });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const persona = data.tasks.find(t => t.id === 'persona');
        expect(persona?.status).toBe('pending');
      });

      it('debrief: done when an active job with debrief in intentAnchor exists', async () => {
        const ctx = makeCtx({ activeJobs: [{ intentAnchor: 'daily_debrief' }] });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const debrief = data.tasks.find(t => t.id === 'debrief');
        expect(debrief?.status).toBe('done');
      });

      it('capability_tour: always done', async () => {
        const ctx = makeCtx();
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const tour = data.tasks.find(t => t.id === 'capability_tour');
        expect(tour?.status).toBe('done');
      });

      it('email: done when both nylas secrets are present', async () => {
        const ctx = makeCtx({
          secrets: {
            'channel.email.nylas_api_key': 'nyk_v0_abc',
            'channel.email.nylas_grant_id': 'grant-xyz',
          },
        });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const email = data.tasks.find(t => t.id === 'email');
        expect(email?.status).toBe('done');
      });

      it('email: pending when nylas_api_key is missing', async () => {
        const ctx = makeCtx({
          secrets: { 'channel.email.nylas_grant_id': 'grant-xyz' }, // api_key absent
        });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const email = data.tasks.find(t => t.id === 'email');
        expect(email?.status).toBe('pending');
      });

      it('email: deferred when no secrets and task_id in deferrals store', async () => {
        // Deferrals stored as JSON array at 'config:setup_wizard::deferrals'
        // (ConfigStore uses subject='config:{namespace}', predicate='{key}')
        const storeData = { 'config:setup_wizard::deferrals': JSON.stringify(['email']) };
        const ctx = makeCtx({ storeData });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        const email = data.tasks.find(t => t.id === 'email');
        expect(email?.status).toBe('deferred');
      });

      it('summary counts are accurate', async () => {
        // persona done, debrief pending, rest pending
        const ctx = makeCtx({ behavioralPreferences: ['concise'] });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { summary: { done: number; pending: number } } }).data;
        // capability_tour always done + persona done = 2 done minimum
        expect(data.summary.done).toBeGreaterThanOrEqual(2);
        expect(data.summary.pending).toBeGreaterThanOrEqual(1);
      });

      it('returns error when entityMemory is absent', async () => {
        const ctx = { input: {}, log: { error: vi.fn() } } as unknown as SkillContext;
        const result = await handler.execute(ctx);
        expect(result.success).toBe(false);
      });
    });

    describe('status across simulated restart', () => {
      it('re-derives status correctly without any stored progress', async () => {
        // Simulate restart: no storeData progress object, but vault keys present
        const ctx = makeCtx({
          secrets: {
            'channel.email.nylas_api_key': 'nyk_v0_abc',
            'channel.email.nylas_grant_id': 'grant-xyz',
            'user.tavily_api_key': 'tvly-abc',
          },
          behavioralPreferences: ['prefers bullet points'],
          activeJobs: [{ intentAnchor: 'weekly_debrief' }],
        });
        const result = await handler.execute(ctx);
        expect(result.success).toBe(true);
        const data = (result as { success: true; data: { tasks: Array<{ id: string; status: string }> } }).data;
        expect(data.tasks.find(t => t.id === 'persona')?.status).toBe('done');
        expect(data.tasks.find(t => t.id === 'debrief')?.status).toBe('done');
        expect(data.tasks.find(t => t.id === 'email')?.status).toBe('done');
        expect(data.tasks.find(t => t.id === 'web_research')?.status).toBe('done');
        expect(data.tasks.find(t => t.id === 'signal')?.status).toBe('pending');
        expect(data.tasks.find(t => t.id === 'kg_memory')?.status).toBe('pending');
      });
    });
  });
  ```

- [ ] **Step 3: Run test to confirm it fails**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run test skills/setup-status/handler.test.ts 2>&1 | tail -20
  ```
  Expected: FAIL with "Cannot find module './handler.js'"

- [ ] **Step 4: Write `skill.json`**

  Note: the `secrets` array declares all vault keys this skill may check. `ctx.secret(name)` throws lazily on access when a key is absent — this is safe to try-catch and is how the handler checks presence.

  ```json
  {
    "name": "setup-status",
    "description": "Return the setup catalog with each task's live-derived status (done / pending / deferred / always_available). Call this at the start of every setup session and after any credential is captured. Never guess at setup state — always call this.",
    "version": "0.1.0",
    "sensitivity": "normal",
    "action_risk": "none",
    "inputs": {},
    "outputs": {
      "tasks": "CatalogTaskWithStatus[] — catalog tasks with status, tier, handoff surface, credential_how_to, docs_url",
      "summary": "{ total: number, done: number, pending: number, deferred: number }"
    },
    "permissions": [],
    "secrets": [
      "channel.email.nylas_api_key",
      "channel.email.nylas_grant_id",
      "channel.signal.socket_path",
      "channel.signal.phone_number",
      "user.tavily_api_key",
      "user.openai_api_key"
    ],
    "timeout": 15000,
    "capabilities": ["entityMemory", "schedulerService", "officeIdentityService"],
    "allowed_callers": ["setup-wizard"]
  }
  ```

- [ ] **Step 5: Write `handler.ts`**

  ```typescript
  // skills/setup-status/handler.ts
  import { readFile } from 'node:fs/promises';
  import { join } from 'node:path';
  import * as yaml from 'js-yaml';
  import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
  import { ConfigStore } from '../../src/memory/config-store.js';

  // ── Catalog types ──────────────────────────────────────────────────────────

  type CompletionCheck =
    | { type: 'behavioral_preferences' }
    | { type: 'scheduler_has_active_debrief' }
    | { type: 'always_available' }
    | { type: 'vault_secrets_all'; keys: string[] };

  interface CatalogTask {
    id: string;
    label: string;
    value_prop: string;
    tier: string;
    handoff: 'in-chat' | 'console';
    handoff_path?: string;
    optional?: boolean;
    completion_check: CompletionCheck;
    credential_how_to: string | null;
    docs_url: string | null;
  }

  type TaskStatus = 'done' | 'pending' | 'deferred';

  interface CatalogTaskWithStatus extends Omit<CatalogTask, 'completion_check'> {
    status: TaskStatus;
  }

  // ── Catalog loading ────────────────────────────────────────────────────────

  let catalogCache: CatalogTask[] | null = null;

  async function loadCatalog(): Promise<CatalogTask[]> {
    if (catalogCache) return catalogCache;
    const catalogPath = join(import.meta.dirname, 'catalog.yaml');
    const raw = await readFile(catalogPath, 'utf-8');
    const parsed = yaml.load(raw) as { tasks: CatalogTask[] };
    catalogCache = parsed.tasks;
    return catalogCache;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function secretPresent(ctx: SkillContext, name: string): boolean {
    try {
      ctx.secret(name);
      return true;
    } catch {
      return false;
    }
  }

  async function loadDeferredSet(ctx: SkillContext): Promise<Set<string>> {
    if (!ctx.entityMemory) return new Set();
    const configStore = new ConfigStore(ctx.entityMemory, ctx.log);
    const stored = await configStore.get('setup_wizard', 'deferrals');
    if (!stored) return new Set();
    try {
      const parsed = JSON.parse(stored) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === 'string')
        : [];
      return new Set(arr);
    } catch {
      ctx.log.warn({ stored }, 'setup-status: deferrals value was not valid JSON — treating as empty');
      return new Set();
    }
  }

  // ── Handler ────────────────────────────────────────────────────────────────

  export class SetupStatusHandler implements SkillHandler {
    async execute(ctx: SkillContext): Promise<SkillResult> {
      if (!ctx.entityMemory) {
        return { success: false, error: 'setup-status requires entityMemory capability.' };
      }

      try {
        const [tasks, deferred] = await Promise.all([loadCatalog(), loadDeferredSet(ctx)]);

        // Resolve live state once (batch, not per-task)
        const behavioralPreferences = ctx.officeIdentityService?.get()?.behavioralPreferences ?? [];
        const personaDone = behavioralPreferences.length > 0;

        let debriefDone = false;
        if (ctx.schedulerService) {
          const jobs = await ctx.schedulerService.listJobs({ status: 'active' });
          debriefDone = jobs.some(
            j => typeof j.intentAnchor === 'string' && j.intentAnchor.includes('debrief'),
          );
        }

        const annotated: CatalogTaskWithStatus[] = tasks.map(task => {
          let done = false;
          const check = task.completion_check;

          switch (check.type) {
            case 'behavioral_preferences':
              done = personaDone;
              break;
            case 'scheduler_has_active_debrief':
              done = debriefDone;
              break;
            case 'always_available':
              done = true;
              break;
            case 'vault_secrets_all':
              done = check.keys.every(k => secretPresent(ctx, k));
              break;
          }

          // "done" wins over deferred — a completed task is done regardless.
          const status: TaskStatus = done ? 'done' : deferred.has(task.id) ? 'deferred' : 'pending';

          const { completion_check: _check, ...rest } = task;
          void _check;
          return { ...rest, status };
        });

        const summary = {
          total: annotated.length,
          done: annotated.filter(t => t.status === 'done').length,
          pending: annotated.filter(t => t.status === 'pending').length,
          deferred: annotated.filter(t => t.status === 'deferred').length,
        };

        return { success: true, data: { tasks: annotated, summary } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err }, 'setup-status failed');
        return { success: false, error: message };
      }
    }
  }
  ```

- [ ] **Step 6: Run tests**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run test skills/setup-status/handler.test.ts 2>&1 | tail -30
  ```
  Expected: all tests PASS.

  Common failure: the `storeData` key format in the test (e.g. `'config:setup_wizard::deferrals'`) must match how ConfigStore actually forms the KG subject/predicate keys. Read `src/memory/config-store.ts` and adjust the test seed format if needed. The handler itself does not need changes — only the test double.

- [ ] **Step 7: Typecheck**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run typecheck 2>&1 | tail -20
  ```
  Expected: no errors.

  Common fix: `import.meta.dirname` requires `"moduleResolution": "nodenext"` in tsconfig (already set). If you see `Property 'dirname' does not exist on type 'ImportMeta'`, add `/// <reference types="vite/client" />` is NOT the fix — instead check that tsconfig.json `"lib"` includes `"ES2022"` or higher.

- [ ] **Step 8: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 add skills/setup-status/skill.json skills/setup-status/catalog.yaml skills/setup-status/handler.ts skills/setup-status/handler.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 commit -m "feat(skills): add setup-status skill with declarative catalog"
  ```

---

## Task 3: Agent prompt v2

Rewrite `agents/setup-wizard.yaml` with the concierge orchestration prompt, catalog awareness, and console vs. in-chat routing. Pin the two new skills. Bump version to `0.2.0`.

**Files:**
- Modify: `agents/setup-wizard.yaml`

**Interfaces:**
- Consumes: `setup-status` (read), `setup-defer` (write), `system-secret-capture-request` (already pinned), `behavioral-preferences-update`, `scheduler-create`, `scheduler-list`, `scheduler-cancel`, `skill-registry`, `memory-store`, `executive-profile-update` (all already pinned)

- [ ] **Step 1: Open `agents/setup-wizard.yaml` and replace the file contents**

  Replace the entire file with:

  ```yaml
  name: setup-wizard
  version: "0.2.0"
  role: specialist
  description: >
    Resumable first-conversation concierge and setup guide. Invoke when the principal
    just completed initial setup (kickoff message contains "Just finished setup"),
    asks "help me set up X" for any integration or feature, requests a capability
    tour ("what can you do?"), or returns to finish deferred setup tasks. Returns
    structured output the coordinator relays: instant wins, setup instructions,
    status summaries, or a capability menu.
  model:
    tier: standard
  system_prompt: |
    You are a setup concierge working as part of an executive assistant team.
    Your output will be presented by the coordinator — do not address the
    principal directly. Write the response the coordinator should relay.

    ## Start of every session

    Call setup-status before doing anything else. Use the result to know:
    - Which tasks are already done
    - Which are deferred (principal asked to skip)
    - Which are pending

    ## On first contact ("Just finished setup" or similar)

    Deliver the instant wins first — no credentials needed:

    1. **Persona:** Offer to capture behavioral preferences (tone, what to prioritize,
       how to communicate). Ask one open-ended question, then call
       behavioral-preferences-update with their answers.
    2. **Debrief:** Ask: "Would a regular digest be useful — daily at end of day, or
       weekly on Fridays?" If yes, call scheduler-create with:
       - intent_anchor: "daily_debrief" or "weekly_debrief" (use exact these strings
         so setup-status can detect the debrief as scheduled)
       - A cron expression matching their preference (e.g. "0 17 * * 1-5" for 5pm
         weekdays, "0 16 * * 5" for 4pm Fridays)
       - task payload: { "type": "debrief", "task": "Generate end-of-day summary" }
    3. **Capability tour:** Call skill-registry and return the top 5–6 things ready
       right now in plain language grouped by area.

    Then ask: "What's the one thing you'd most like me to help with — email,
    research, scheduling, or something else?" Map their answer to the relevant
    catalog task and begin that flow. One question per turn.

    ## Catalog awareness

    You always know the full setup menu via setup-status. Show it on request
    ("what else can you set up?") or proactively offer the next highest-value
    pending item. Never invent tasks — only offer tasks in the catalog.

    ## Routing by task type

    ### Console handoff (email, Signal)
    For tasks with handoff "console":
    1. Tell the principal to go to Settings → Channels (use the handoff_path from
       the catalog task).
    2. Relay the credential_how_to from the catalog task verbatim.
    3. Provide the docs_url as a full link: "Full guide: [docs_url]".
    4. Wait for them to confirm they've entered the credentials.
    5. Call setup-status to confirm. Acknowledge the new status:
       "Your email channel is all set —" or tell them what's still missing.
    6. Never claim a channel is working without a live setup-status confirmation.

    ### In-chat capture (Tavily, OpenAI embeddings, any one-key secret)
    For tasks with handoff "in-chat" that need a secret:
    1. Call system-secret-capture-request with the exact vault key from the
       catalog task's completion_check.keys[0]
       (e.g. "user.tavily_api_key", "user.openai_api_key").
    2. Send the one-time link. Explain: "Click the link, paste your key — it goes
       straight to the vault; I never see it."
    3. After they fill it in, you may be resumed automatically. Call setup-status
       to confirm, then acknowledge.
    4. Channel and system secrets need a restart to take effect; user.* secrets
       (Tavily, OpenAI) are live immediately.

    ## Deferral

    If the principal says they want to skip a task:
    1. Call setup-defer with action "defer" and the task_id from the catalog.
    2. Acknowledge: "Got it — we can come back to this anytime."
    3. Do not re-offer deferred tasks unsolicited.

    To resume a deferred task at the principal's request:
    1. Call setup-defer with action "resume" for that task_id.
    2. Proceed with the task flow above.

    ## On re-engagement

    When the principal returns to finish setup (not a first-contact kickoff):
    1. Call setup-status.
    2. Acknowledge any newly completed items since last session.
    3. Ask what they'd like to tackle next, or offer the highest-value pending task.

    ## KG entity memory (optional)

    The kg_memory task is optional. Offer it opportunistically when setup is
    otherwise complete, or when the principal asks about memory. Never push it,
    never imply it blocks value, never ask about it more than once per session.

    ## Rules

    - Each invocation is fresh — you have no persistent state. Always call
      setup-status first.
    - Never address the principal directly — always write what the coordinator
      should relay.
    - One question per turn maximum.
    - Deliver instant wins before asking for any credential.
    - After capturing any preference, call behavioral-preferences-update (append).
    - After any credential setup, call setup-status to confirm — never assume success.

  pinned_skills:
    - setup-status
    - setup-defer
    - behavioral-preferences-update
    - scheduler-create
    - scheduler-list
    - scheduler-cancel
    - skill-registry
    - memory-store
    - executive-profile-update
    - system-secret-capture-request
  allow_discovery: false
  inject_specialists: false
  ```

- [ ] **Step 2: Typecheck (agents/*.yaml are not TypeScript, but validate the surrounding build passes)**

  ```bash
  pnpm -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 run typecheck 2>&1 | tail -10
  ```
  Expected: no errors.

- [ ] **Step 3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 add agents/setup-wizard.yaml
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 commit -m "feat(agent): setup-wizard v2 — outcome-backward concierge prompt"
  ```

---

## Task 4: CLAUDE.md coaching note + CHANGELOG

Add a developer coaching note so the catalog never silently drifts stale. Update CHANGELOG.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the coaching note to `CLAUDE.md`**

  Find the section `### New Agent` (around line 135). Insert the following block **after** the "New Agent" section and **before** whatever follows it (likely "### Reaching the principal"):

  ```markdown
  ### Setup wizard — keep the catalog current

  When adding a **significant new capability** — a new channel adapter, a new
  third-party integration, a credential-requiring skill bundle, or a major skill
  that changes what a new user would want to configure — check whether the setup
  wizard catalog needs a matching entry:

  - The catalog lives in `skills/setup-status/catalog.yaml`. It is the canonical
    list of "what a new user sets up" and is owned by the setup-wizard agent, not
    core.
  - If your change adds a configurable capability, add a catalog entry with:
    - A `completion_check` (how setup-status detects it is done)
    - A `credential_how_to` summary (one-sentence inline guide)
    - A `docs_url` pointing to the relevant curia-docs page
  - If the docs page does not exist yet, create it in `curia-docs` as part of
    shipping the capability — not as a follow-up.
  - If your change **removes** or **renames** a capability, remove or update the
    catalog entry and its docs link.

  Keeping the catalog current is part of shipping the capability, not a follow-up
  task.
  ```

- [ ] **Step 2: Add CHANGELOG entries**

  Open `CHANGELOG.md` and add under `## [Unreleased]` → `### Added`:

  ```markdown
  - `setup-status` skill: read-only, returns the setup catalog with each task's live-derived status (`done` / `pending` / `deferred`). Catalog (`catalog.yaml`) is owned by the skill bundle, not core.
  - `setup-defer` skill: write (`action_risk: low`), persists/clears setup task deferrals in config-store (`setup_wizard/deferrals`).
  - `setup-wizard` v0.2.0: outcome-backward concierge prompt — instant wins first, then outcome question → shortest path → defer the rest. Routes email/Signal to console, lone API keys to in-chat capture. Catalog-aware (full menu on request, resume deferred tasks). Replaces v0.1.x turn-by-turn script.
  - `CLAUDE.md` coaching note: contributors adding new credentialed capabilities or changing default behavior should update the setup-wizard catalog and its docs.
  ```

- [ ] **Step 3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 add CLAUDE.md CHANGELOG.md
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard-v2 commit -m "chore: add setup-wizard catalog coaching note to CLAUDE.md; update CHANGELOG"
  ```

---

## Task 5: curia-docs pages

Two new pages (Tavily, OpenAI embeddings) and updates to the existing email and Signal pages to include console credential entry instructions. **This is a separate git repo** — create a new worktree before starting.

**Repo:** `repos/curia-docs`
**Worktree:** `worktrees/curia-docs-setup-wizard-v2` (branch: `feat/setup-wizard-v2-docs`)

**Files:**
- Create: `worktrees/curia-docs-setup-wizard-v2/integrations/tavily.mdx`
- Create: `worktrees/curia-docs-setup-wizard-v2/integrations/openai-embeddings.mdx`
- Modify: `worktrees/curia-docs-setup-wizard-v2/channels/email-setup.mdx`
- Modify: `worktrees/curia-docs-setup-wizard-v2/channels/signal-setup.mdx`
- Modify: `worktrees/curia-docs-setup-wizard-v2/docs.json`

- [ ] **Step 1: Create the curia-docs worktree**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-docs pull --ff-only origin main
  git -C /Users/josephfung/Projects/office-of-the-ceo/repos/curia-docs worktree add /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-docs-setup-wizard-v2 -b feat/setup-wizard-v2-docs
  ```

- [ ] **Step 2: Create `integrations/tavily.mdx`**

  ```mdx
  ---
  title: "Connect Tavily for live web search"
  description: "Get a Tavily API key and enter it so Curia can run real-time web searches for research tasks and news."
  ---

  Curia's web research capability is powered by [Tavily](https://tavily.com) — a search API built for AI agents. Once connected, Curia can answer research questions, summarize news, and fact-check in real time.

  ## Get a Tavily API key

  <Steps>
    <Step title="Sign up at tavily.com">
      Go to [tavily.com](https://tavily.com) and create an account. The free tier includes enough requests for typical personal use.
    </Step>

    <Step title="Copy your API key">
      After signing in, your API key is shown on the dashboard. It starts with `tvly-`.
    </Step>
  </Steps>

  ## Enter the key via the setup wizard

  Ask Curia's setup wizard to connect web search. It will send you a one-time secure link — paste your Tavily API key into the form and submit. The key goes straight to the vault; Curia never sees it in plaintext.

  The web research skill is active immediately after the key is saved (no restart needed).

  ## Verify it is working

  Ask Curia something that requires a live search, for example: "What's the latest news on [topic]?" A successful response with current information confirms the connection is working.
  ```

- [ ] **Step 3: Create `integrations/openai-embeddings.mdx`**

  ```mdx
  ---
  title: "Enable semantic memory with OpenAI embeddings"
  description: "Add an OpenAI API key to unlock knowledge-graph entity memory — Curia remembers people, projects, and context across conversations."
  ---

  Curia's knowledge graph uses OpenAI's embedding API to build semantic memory: relationships between people, projects, and topics that persist across conversations. This is optional — Curia is fully functional without it.

  ## Get an OpenAI API key

  <Steps>
    <Step title="Create an account at platform.openai.com">
      Go to [platform.openai.com](https://platform.openai.com) and sign in or create an account.
    </Step>

    <Step title="Generate an API key">
      Under **API keys**, click **Create new secret key**. Copy it immediately — it is only shown once.
    </Step>

    <Step title="Add billing">
      Embedding calls are low-cost but require a payment method. Add one under **Billing → Payment methods**. A few dollars of credit covers typical usage for months.
    </Step>
  </Steps>

  ## Enter the key via the setup wizard

  Ask Curia's setup wizard to enable knowledge graph memory. It will send you a one-time secure link — paste your OpenAI API key and submit. The key goes straight to the vault.

  The embedding capability is active immediately after the key is saved (no restart needed).

  ## What changes after connecting

  Curia begins building entity nodes for people you mention, projects you discuss, and topics that recur. Over time this creates a network of relationships that informs research, drafting, and scheduling. The change is gradual — you won't notice it immediately, but it compounds over weeks of use.
  ```

- [ ] **Step 4: Add "Console credential entry" section to `channels/email-setup.mdx`**

  Read the current file and append the following section after the existing single-account setup steps (after line ~50):

  ```mdx
  ## Console credential entry (recommended for production)

  Instead of setting environment variables, you can enter Nylas credentials directly in Curia's web console — no restart required once they are saved.

  <Steps>
    <Step title="Open Settings → Channels">
      In the Curia console, go to **Settings → Channels** and find the **Email** channel.
    </Step>

    <Step title="Enter your credentials">
      Paste your `NYLAS_API_KEY`, `NYLAS_GRANT_ID`, and `NYLAS_SELF_EMAIL` into the respective fields. Each field shows a live status indicator (vault / env / missing) so you can see which values are already configured.
    </Step>

    <Step title="Confirm the connection">
      Ask the setup wizard to confirm your email channel is active. It calls the live status check and tells you whether the channel is ready or what is still missing.
    </Step>
  </Steps>

  <Note>
    Channel credentials entered via the console are stored in Curia's encrypted vault and take precedence over environment variables. A restart is required for the email adapter to pick up newly entered credentials.
  </Note>
  ```

- [ ] **Step 5: Add "Console credential entry" section to `channels/signal-setup.mdx`**

  Read the current file and find a good insertion point (after the existing setup steps). Append:

  ```mdx
  ## Console credential entry

  Once signal-cli is running and your phone number is registered, you can enter the connection details in Curia's console instead of setting environment variables.

  <Steps>
    <Step title="Open Settings → Channels">
      In the Curia console, go to **Settings → Channels** and find the **Signal** channel.
    </Step>

    <Step title="Enter the socket path and phone number">
      - **Socket path:** The Unix socket path that signal-cli exposes (set automatically by Docker Compose as `/var/run/signal-cli/socket`).
      - **Phone number:** Your registered Signal number in E.164 format (e.g. `+12223334444`).
    </Step>

    <Step title="Confirm with the setup wizard">
      Ask the setup wizard to verify your Signal channel. It checks live status and tells you whether the channel is ready.
    </Step>
  </Steps>

  <Note>
    Device linking (the QR-scan step to link a secondary device) is a separate manual step not currently guided by the setup wizard. See [Step 2 — Bootstrap signal-cli](#step-2-bootstrap-signal-cli) above for instructions.
  </Note>
  ```

- [ ] **Step 6: Add the new pages to `docs.json`**

  Read `docs.json` to find the navigation structure. Add an `"integrations"` group with the two new pages. The exact JSON location depends on the current structure — look for the `navigation` array and add:

  ```json
  {
    "group": "Integrations",
    "pages": [
      "integrations/tavily",
      "integrations/openai-embeddings"
    ]
  }
  ```

  Place it after the "Channels" group and before "Skills" (or wherever makes sense in the current nav order).

- [ ] **Step 7: Commit docs**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-docs-setup-wizard-v2 add integrations/tavily.mdx integrations/openai-embeddings.mdx channels/email-setup.mdx channels/signal-setup.mdx docs.json
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-docs-setup-wizard-v2 commit -m "docs: add Tavily and OpenAI embeddings setup pages; add console credential entry sections to email and Signal"
  ```

---

## Pre-PR review

Before opening PRs, run the two review subagents in parallel from the office-of-the-ceo workspace root:

1. **Code reviewer** (curia branch): check all changes on `feat/setup-wizard-v2` vs main
2. **Silent-failure hunter** (curia branch): check for swallowed errors and bad fallbacks — particularly in the try-catch secret presence checks

Address any high-priority findings before creating the PRs.

## Create PRs

Two PRs, one per repo:

```bash
# Curia PR
gh pr create \
  --repo josephfung/curia \
  --head feat/setup-wizard-v2 \
  --base main \
  --title "feat(agent): setup-wizard v2 — resumable, value-first setup concierge" \
  --body "$(cat <<'EOF'
Closes #808

## Summary

- Adds `setup-status` skill: declarative catalog in `catalog.yaml`, derives task status from live system state (vault keys, scheduler jobs, behavioral preferences). No stored progress.
- Adds `setup-defer` skill: persists/clears deferrals in config-store (`setup_wizard/deferrals` as a JSON array).
- Rewrites `setup-wizard` prompt to v0.2.0: outcome-backward concierge (instant wins → outcome question → shortest path → defer the rest), catalog-aware, routes email/Signal to console and lone keys to in-chat capture.
- Adds developer coaching note to `CLAUDE.md`: catalog stays current as capabilities are added.

## Test plan

- [ ] `pnpm -C worktrees/curia-setup-wizard-v2 run test skills/setup-defer/handler.test.ts` — all pass
- [ ] `pnpm -C worktrees/curia-setup-wizard-v2 run test skills/setup-status/handler.test.ts` — all pass, including the restart-simulation test
- [ ] `pnpm -C worktrees/curia-setup-wizard-v2 run typecheck` — no errors
- [ ] Manual: start a fresh Curia instance, trigger setup-wizard, verify instant wins delivered before any credential request
- [ ] Manual: enter a Nylas credential via Settings → Channels, confirm wizard acknowledges via live setup-status call
- [ ] Manual: defer a task, restart process, re-trigger wizard — deferred task shows as deferred (not pending, not done)
EOF
)"

# curia-docs PR
gh pr create \
  --repo josephfung/curia-docs \
  --head feat/setup-wizard-v2-docs \
  --base main \
  --title "docs: Tavily and OpenAI embeddings setup; console credential entry for email and Signal" \
  --body "$(cat <<'EOF'
Companion to josephfung/curia#808.

## Summary

- New pages: `integrations/tavily.mdx`, `integrations/openai-embeddings.mdx`
- Updated: `channels/email-setup.mdx` and `channels/signal-setup.mdx` — added console credential entry sections
- Updated: `docs.json` navigation — added Integrations group
EOF
)"
```

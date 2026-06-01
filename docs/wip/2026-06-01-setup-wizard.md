# Setup Wizard v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the setup-wizard specialist agent, behavioral-preferences-update skill, and chat auto-kickoff that guide users through their first Curia conversation.

**Architecture:** A new `setup-wizard` specialist agent is invoked by the coordinator via the existing `delegate` skill. It uses a new `behavioral-preferences-update` skill to persist preferences captured during the interview. The frontend auto-sends a kickoff message on first mount when the onboarding flag is set.

**Tech Stack:** TypeScript/ESM, Vitest, YAML agent config, React hooks, pino, pg (PostgreSQL)

**Worktree:** `/Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard` (branch `feat/setup-wizard`)

**Design spec:** `docs/wip/2026-06-01-setup-wizard-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/skills/types.ts` | Modify | Add `officeIdentityService` to `SkillContext` |
| `src/skills/loader.ts` | Modify | Add `'officeIdentityService'` to `VALID_CAPABILITIES` |
| `src/skills/execution.ts` | Modify | Add capability field, constructor option, and map entry |
| `src/index.ts` | Modify | Pass `officeIdentityService` to `ExecutionLayer` constructor |
| `skills/behavioral-preferences-update/skill.json` | Create | Skill manifest |
| `skills/behavioral-preferences-update/handler.ts` | Create | Skill handler |
| `skills/behavioral-preferences-update/handler.test.ts` | Create | Unit tests |
| `agents/setup-wizard.yaml` | Create | Agent config |
| `apps/console/src/pages/chat/useChatSession.ts` | Modify | Chat auto-kickoff |
| `tests/integration/setup-wizard-delegate.test.ts` | Create | Integration test |
| `CHANGELOG.md` | Modify | Release notes |

---

## Task 1: Add `officeIdentityService` capability to the execution layer

This is pure infrastructure plumbing. `behavioral-preferences-update` declares `capabilities: ["officeIdentityService"]`; the execution layer must know how to inject it. No unit test needed — TypeScript compilation is the verification.

**Files:**
- Modify: `src/skills/types.ts`
- Modify: `src/skills/loader.ts`
- Modify: `src/skills/execution.ts`
- Modify: `src/index.ts`

- [ ] **Step 1.1: Add `officeIdentityService` to `SkillContext` in `src/skills/types.ts`**

  Find the `executiveProfileService` field (around line 194) and add the new field immediately after it:

  ```typescript
  /** Executive profile service — available to skills declaring 'executiveProfileService' in capabilities.
   *  Manages the CEO's writing voice profile. */
  executiveProfileService?: import('../executive/service.js').ExecutiveProfileService;
  /** Office identity service — available to skills declaring 'officeIdentityService' in capabilities.
   *  Manages the Curia instance identity including behavioral preferences. */
  officeIdentityService?: import('../identity/service.js').OfficeIdentityService;
  ```

- [ ] **Step 1.2: Add `'officeIdentityService'` to `VALID_CAPABILITIES` in `src/skills/loader.ts`**

  Find the `VALID_CAPABILITIES` set (line 27) and add the new entry after `'executiveProfileService'`:

  ```typescript
  'executiveProfileService',
  'officeIdentityService',
  ```

- [ ] **Step 1.3: Add three additions to `src/skills/execution.ts`**

  **A) Private field** — after the `executiveProfileService` private field (around line 82):
  ```typescript
  private executiveProfileService?: import('../executive/service.js').ExecutiveProfileService;
  private officeIdentityService?: import('../identity/service.js').OfficeIdentityService;
  ```

  **B) Constructor option** — after `executiveProfileService` in the options object (around line 114):
  ```typescript
  executiveProfileService?: import('../executive/service.js').ExecutiveProfileService;
  officeIdentityService?: import('../identity/service.js').OfficeIdentityService;
  ```

  **C) Constructor body assignment** — after `this.executiveProfileService` (around line 142):
  ```typescript
  this.executiveProfileService = options?.executiveProfileService;
  this.officeIdentityService = options?.officeIdentityService;
  ```

  **D) `capabilityServices` map** — after the `executiveProfileService` entry (around line 576):
  ```typescript
  executiveProfileService: this.executiveProfileService,
  officeIdentityService: this.officeIdentityService,
  ```

- [ ] **Step 1.4: Pass `officeIdentityService` to the `ExecutionLayer` constructor in `src/index.ts`**

  Find the single `new ExecutionLayer(...)` call (line 1253). It currently has `executiveProfileService,` in the options — add `officeIdentityService,` immediately after:

  ```typescript
  // Before:
  ...autonomyService, executiveProfileService, browserService...

  // After:
  ...autonomyService, executiveProfileService, officeIdentityService, browserService...
  ```

  The variable `officeIdentityService` is already in scope (initialized at line 272).

- [ ] **Step 1.5: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run typecheck
  ```

  Expected: no errors. If TypeScript complains about the `officeIdentityService` variable not being found in `index.ts`, verify you are referencing the `officeIdentityService` const from line 272, not a renamed local.

- [ ] **Step 1.6: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add src/skills/types.ts src/skills/loader.ts src/skills/execution.ts src/index.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "feat: add officeIdentityService capability to execution layer"
  ```

---

## Task 2: `behavioral-preferences-update` skill (TDD)

**Files:**
- Create: `skills/behavioral-preferences-update/handler.test.ts`
- Create: `skills/behavioral-preferences-update/skill.json`
- Create: `skills/behavioral-preferences-update/handler.ts`

- [ ] **Step 2.1: Write the failing tests in `skills/behavioral-preferences-update/handler.test.ts`**

  ```typescript
  // handler.test.ts — behavioral-preferences-update skill
  import { describe, it, expect, vi, beforeEach } from 'vitest';
  import { BehavioralPreferencesUpdateHandler } from './handler.js';
  import type { SkillContext } from '../../src/skills/types.js';
  import type { OfficeIdentity } from '../../src/identity/types.js';

  function makeContext(overrides: Partial<SkillContext> = {}): SkillContext {
    return {
      input: {},
      log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      caller: { role: 'principal', contactId: 'contact-123' },
      ...overrides,
    } as unknown as SkillContext;
  }

  const BASE_IDENTITY: OfficeIdentity = {
    assistant: { name: 'Curia', title: 'Chief of Staff', emailSignature: '' },
    tone: { baseline: ['professional'], verbosity: 50, directness: 50 },
    behavioralPreferences: ['Be concise', 'Prioritize signal over noise'],
    decisionStyle: { externalActions: 'balanced', internalAnalysis: 'balanced' },
    constraints: [],
  };

  function makeOfficeIdentityService(identity: OfficeIdentity = BASE_IDENTITY) {
    // Clone so tests don't share mutable state.
    const state: OfficeIdentity = {
      ...identity,
      behavioralPreferences: [...identity.behavioralPreferences],
    };
    return {
      get: vi.fn((): OfficeIdentity => ({ ...state, behavioralPreferences: [...state.behavioralPreferences] })),
      update: vi.fn(async (newIdentity: OfficeIdentity) => {
        state.behavioralPreferences = [...newIdentity.behavioralPreferences];
      }),
    };
  }

  describe('BehavioralPreferencesUpdateHandler', () => {
    let handler: BehavioralPreferencesUpdateHandler;

    beforeEach(() => {
      handler = new BehavioralPreferencesUpdateHandler();
    });

    it('append adds new entries to existing preferences', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'append', entries: ['Reply within 24h'] },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as { preferences: string[]; summary: string; changes: string };
      expect(data.preferences).toEqual([
        'Be concise',
        'Prioritize signal over noise',
        'Reply within 24h',
      ]);
      expect(service.update).toHaveBeenCalledOnce();
    });

    it('append is idempotent — entries already present are not duplicated', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'append', entries: ['Be concise'] },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as { preferences: string[] };
      // 'Be concise' was already present — list length must not grow.
      expect(data.preferences).toEqual(['Be concise', 'Prioritize signal over noise']);
      // No DB write when nothing changed.
      expect(service.update).not.toHaveBeenCalled();
    });

    it('replace overwrites the entire list', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'replace', entries: ['New preference only'] },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      if (!result.success) return;
      const data = result.data as { preferences: string[] };
      expect(data.preferences).toEqual(['New preference only']);
      expect(service.update).toHaveBeenCalledOnce();
    });

    it('returns failure when officeIdentityService is absent', async () => {
      const ctx = makeContext({ input: { operation: 'append', entries: ['x'] } });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('returns failure for an unrecognised operation', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'upsert', entries: ['x'] },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('returns failure for an empty entries array', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'append', entries: [] },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });

    it('returns failure for a non-array entries value', async () => {
      const service = makeOfficeIdentityService();
      const ctx = makeContext({
        officeIdentityService: service as unknown as SkillContext['officeIdentityService'],
        input: { operation: 'append', entries: 'not-an-array' },
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
    });
  });
  ```

- [ ] **Step 2.2: Run tests to confirm they fail**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run test -- skills/behavioral-preferences-update/handler.test.ts
  ```

  Expected: all tests FAIL with module-not-found or similar — `handler.ts` doesn't exist yet.

- [ ] **Step 2.3: Create `skills/behavioral-preferences-update/skill.json`**

  ```json
  {
    "name": "behavioral-preferences-update",
    "description": "Append or replace entries in the assistant's behavioral-preferences list. Use 'append' to add new preferences without discarding existing ones (idempotent — safe to call repeatedly); use 'replace' to overwrite the full list. Requires CEO authorization. Use after capturing a preference in conversation.",
    "version": "1.0.0",
    "sensitivity": "elevated",
    "capabilities": ["officeIdentityService"],
    "inputs": {
      "operation": "string",
      "entries": "array"
    },
    "outputs": { "preferences": "array", "summary": "string", "changes": "string" },
    "permissions": [],
    "secrets": [],
    "timeout": 15000,
    "action_risk": "low"
  }
  ```

- [ ] **Step 2.4: Create `skills/behavioral-preferences-update/handler.ts`**

  ```typescript
  // handler.ts — behavioral-preferences-update skill
  //
  // Writes to OfficeIdentity.behavioralPreferences via OfficeIdentityService.
  // 'append' deduplicates by exact string match (idempotent; skips DB write if nothing changed).
  // 'replace' overwrites the full list unconditionally.
  // Mirrors the executive-profile-update skill pattern.

  import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
  import type { OfficeIdentity } from '../../src/identity/types.js';

  export class BehavioralPreferencesUpdateHandler implements SkillHandler {
    async execute(ctx: SkillContext): Promise<SkillResult> {
      if (!ctx.officeIdentityService) {
        return {
          success: false,
          error: 'behavioral-preferences-update requires officeIdentityService in context.',
        };
      }

      const { operation, entries } = ctx.input as { operation?: unknown; entries?: unknown };

      if (operation !== 'append' && operation !== 'replace') {
        return { success: false, error: 'operation must be "append" or "replace".' };
      }
      if (
        !Array.isArray(entries) ||
        entries.length === 0 ||
        !entries.every((e) => typeof e === 'string')
      ) {
        return { success: false, error: 'entries must be a non-empty array of strings.' };
      }

      try {
        const current = ctx.officeIdentityService.get();
        const existing = current.behavioralPreferences;

        let merged: string[];
        let changes: string;

        if (operation === 'append') {
          const newEntries = (entries as string[]).filter((e) => !existing.includes(e));
          if (newEntries.length === 0) {
            // Nothing to write — return current state without a DB round-trip.
            return {
              success: true,
              data: {
                preferences: existing,
                summary: 'Behavioral preferences unchanged.',
                changes: 'no new entries (all already present)',
              },
            };
          }
          merged = [...existing, ...newEntries];
          changes =
            `appended ${newEntries.length} entr${newEntries.length === 1 ? 'y' : 'ies'}: ` +
            newEntries.map((e) => `"${e}"`).join(', ');
        } else {
          merged = entries as string[];
          changes = `replaced all preferences (${existing.length} → ${merged.length} entries)`;
        }

        const actor = ctx.caller?.contactId ?? ctx.caller?.role ?? 'unknown';
        const updated: OfficeIdentity = { ...current, behavioralPreferences: merged };
        await ctx.officeIdentityService.update(
          updated,
          'skill',
          `behavioral-preferences-update: ${changes} (by ${actor})`,
        );

        return {
          success: true,
          data: {
            preferences: merged,
            summary: 'Behavioral preferences updated.',
            changes,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err }, 'behavioral-preferences-update failed');
        return { success: false, error: message };
      }
    }
  }
  ```

- [ ] **Step 2.5: Run tests to confirm they pass**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run test -- skills/behavioral-preferences-update/handler.test.ts
  ```

  Expected: all 7 tests PASS.

- [ ] **Step 2.6: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run typecheck
  ```

  Expected: no errors.

- [ ] **Step 2.7: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add skills/behavioral-preferences-update/
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "feat(skill): add behavioral-preferences-update (#486)"
  ```

---

## Task 3: `agents/setup-wizard.yaml`

**Files:**
- Create: `agents/setup-wizard.yaml`

- [ ] **Step 3.1: Create `agents/setup-wizard.yaml`**

  ```yaml
  name: setup-wizard
  role: specialist
  description: >
    First-conversation specialist and setup guide. Invoke when the principal
    just completed initial setup (kickoff message contains "Just finished setup"),
    asks "help me set up X" for any integration or feature, or requests a
    capability tour ("what can you do?"). Returns structured output the
    coordinator relays: greeting, interview questions, setup instructions,
    or a capability summary.
  model:
    tier: standard
  system_prompt: |
    You are a setup and onboarding specialist working as part of an executive
    assistant team. Your output will be presented by the coordinator — do not
    address the principal directly. Write the response the coordinator should relay.

    ## First-conversation flow

    Triggered when the task brief contains a kickoff message
    ("Just finished setup" or similar). Run this sequence across turns:

    **Turn 1 — Greeting + priorities question:**
    Warm greeting. Acknowledge this is a first conversation. Ask: "What takes
    up most of your time right now — email, scheduling, research, staying on
    top of news?" (one question only; the coordinator will personalize with
    the principal's name when relaying).

    **Turn 2 — Feature suggestions:**
    Map their answer to concrete next steps:
    - Email-heavy → suggest setting up Nylas (env vars: NYLAS_API_KEY, NYLAS_GRANT_ID)
    - Calendar-heavy → suggest connecting Google Calendar via Nylas
    - Research / news → "You're already covered — I have web search built in"
    - Scheduling → "Calendar tools are ready once Nylas is connected"
    Persist a preference note via behavioral-preferences-update (append).
    Then ask: "What are your usual working hours and timezone?"

    **Turn 3 — Debrief cadence:**
    Acknowledge the hours. Ask: "Would a regular debrief be useful — say,
    a quick daily summary at end of day, or a weekly digest on Fridays?"

    **Turn 4 — Wrap-up:**
    If they want a debrief: offer to schedule it via scheduler-create.
    Close with a brief summary of what was set up and what's next.

    ## Capability tour

    When asked "what can you do?" or similar: call skill-registry and return
    a plain-language summary grouped by category (email, calendar, research,
    scheduling, memory). Keep it to ~5 bullets.

    ## Integration setup (v1)

    When asked about setting up Nylas, Twilio, Signal, OpenAI key, or similar:
    - Return the specific env var names needed and a one-line description of each.
    - Add: "After setting these, restart Curia and I'll be ready to use them."
    - Add: "An in-app setup flow for this is coming in v2."

    ## Rules

    - You have no persistent state. Each invocation is fresh.
    - Never address the principal directly — always write what the coordinator should say.
    - Keep each turn concise. One question per turn maximum.
    - After each meaningful preference captured, call behavioral-preferences-update (append).

  pinned_skills:
    - behavioral-preferences-update
    - scheduler-create
    - scheduler-list
    - scheduler-cancel
    - skill-registry
    - memory-store
    - executive-profile-update
  allow_discovery: false
  inject_specialists: false
  ```

- [ ] **Step 3.2: Run typecheck to verify the YAML parses cleanly at startup**

  The agent loader validates YAML at startup; TypeScript won't catch this, but a quick sanity check via typecheck will surface any import issues introduced nearby:

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run typecheck
  ```

  Expected: no errors.

- [ ] **Step 3.3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add agents/setup-wizard.yaml
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "feat(agent): add setup-wizard specialist (#486)"
  ```

---

## Task 4: Frontend chat auto-kickoff

**Files:**
- Modify: `apps/console/src/pages/chat/useChatSession.ts`

- [ ] **Step 4.1: Add the two new constants after `CONV_ID_KEY`**

  Find line 8 (`const CONV_ID_KEY = 'curia:chat:conversationId';`) and add immediately after:

  ```typescript
  const CONV_ID_KEY = 'curia:chat:conversationId';
  // Onboarding kickoff — set by the setup wizard page after form submission.
  const ONBOARDING_KICKOFF_KEY = 'curia:onboarding:welcome-banner-pending';
  const KICKOFF_TEXT = 'Just finished setup — say hi!';
  ```

- [ ] **Step 4.2: Add the `pendingKickoff` ref inside the hook**

  Find the `conversationId` ref initializer (lines 61–66). Add the `pendingKickoff` ref immediately after it:

  ```typescript
  const conversationId = useRef<string | null>(
    (() => {
      if (typeof window === 'undefined') return null;
      try { return localStorage.getItem(CONV_ID_KEY); } catch { return null; }
    })(),
  );
  // One-shot kickoff: read and clear the onboarding flag synchronously so a
  // React strict-mode double-mount cannot fire a second auto-send.
  const pendingKickoff = useRef(
    (() => {
      if (typeof window === 'undefined') return false;
      try {
        const flag = localStorage.getItem(ONBOARDING_KICKOFF_KEY);
        if (flag !== null && !conversationId.current) {
          localStorage.removeItem(ONBOARDING_KICKOFF_KEY);
          return true;
        }
        return false;
      } catch { return false; }
    })(),
  );
  ```

- [ ] **Step 4.3: Add the auto-send `useEffect`**

  Find the existing `useEffect` that runs the history load on mount (around line 74). Add the new effect **after** it (after the closing `}, []);` of the history effect, before `const loadMore = useCallback`):

  ```typescript
  // Auto-send the onboarding kickoff message once on first mount.
  // send is captured from this render; deps omitted intentionally (one-shot).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pendingKickoff.current) return;
    void send(KICKOFF_TEXT);
  }, []);
  ```

- [ ] **Step 4.4: Run typecheck**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run typecheck
  ```

  Expected: no errors.

- [ ] **Step 4.5: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add apps/console/src/pages/chat/useChatSession.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "feat(console): auto-send onboarding kickoff on first chat mount (#486)"
  ```

---

## Task 5: Integration test

**Files:**
- Create: `tests/integration/setup-wizard-delegate.test.ts`

- [ ] **Step 5.1: Write the integration test**

  This test mirrors `tests/integration/multi-agent-delegation.test.ts`. It uses a mock LLM for both coordinator and specialist, so no real Postgres or live LLM is needed.

  ```typescript
  // tests/integration/setup-wizard-delegate.test.ts
  //
  // Verifies coordinator routing decisions for setup-wizard delegation.
  // Uses mock LLM providers — no real Postgres or Anthropic API required.

  import { describe, it, expect } from 'vitest';
  import { EventBus } from '../../src/bus/bus.js';
  import { AgentRuntime } from '../../src/agents/runtime.js';
  import { AgentRegistry } from '../../src/agents/agent-registry.js';
  import { SkillRegistry } from '../../src/skills/registry.js';
  import { ExecutionLayer } from '../../src/skills/execution.js';
  import { DelegateHandler } from '../../skills/delegate/handler.js';
  import { createAgentTask } from '../../src/bus/events.js';
  import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
  import type { SkillManifest } from '../../src/skills/types.js';
  import pino from 'pino';

  const MOCK_PROVENANCE = {
    requestedModel: 'mock-model',
    actualModel: 'mock-model',
    providerRequestId: 'msg_mock_000',
  } as const;

  const logger = pino({ level: 'silent' });

  const KICKOFF_TEXT = 'Just finished setup — say hi!';

  function makeSetup() {
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('setup-wizard', {
      role: 'specialist',
      description: 'First-conversation specialist and setup guide.',
    });

    const skillRegistry = new SkillRegistry();
    const delegateManifest: SkillManifest = {
      name: 'delegate',
      description: 'Delegate a task to a specialist agent',
      version: '1.0.0',
      sensitivity: 'normal',
      action_risk: 'none',
      capabilities: ['bus', 'agentRegistry'],
      inputs: { agent: 'string', task: 'string', conversation_id: 'string?' },
      outputs: { response: 'string', agent: 'string' },
      permissions: [],
      secrets: [],
      timeout: 120000,
    };
    skillRegistry.register(delegateManifest, new DelegateHandler());

    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    return { agentRegistry, skillRegistry, bus, executionLayer };
  }

  describe('setup-wizard delegation', () => {
    it('coordinator delegates to setup-wizard for the onboarding kickoff message', async () => {
      const { bus, executionLayer, skillRegistry } = makeSetup();

      let specialistCalls = 0;
      const setupWizardProvider: LLMProvider = {
        id: 'mock-setup-wizard',
        chat: async () => {
          specialistCalls++;
          return {
            type: 'text' as const,
            content: 'Warm greeting — great to meet you! What takes up most of your time right now?',
            usage: { inputTokens: 50, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        },
      };

      let coordinatorCalls = 0;
      const coordinatorProvider: LLMProvider = {
        id: 'mock-coordinator',
        chat: async ({ messages }: { messages: Message[] }) => {
          coordinatorCalls++;
          if (coordinatorCalls === 1) {
            // Coordinator recognises kickoff and delegates to setup-wizard.
            return {
              type: 'tool_use' as const,
              toolCalls: [{
                id: 'call-1',
                name: 'delegate',
                input: {
                  agent: 'setup-wizard',
                  task: KICKOFF_TEXT,
                  conversation_id: 'test-conv-kickoff',
                },
              }],
              usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
              provenance: MOCK_PROVENANCE,
            };
          }
          // Second call: synthesize the specialist's response.
          const hasToolResult = messages.some(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some((b: ContentBlock) => b.type === 'tool_result'),
          );
          return {
            type: 'text' as const,
            content: `Hi! Great to meet you. ${hasToolResult ? '(setup-wizard responded)' : ''} What takes up most of your time?`,
            usage: { inputTokens: 200, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        },
      };

      const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

      const coordinator = new AgentRuntime({
        agentId: 'coordinator',
        systemPrompt: 'You are a coordinator.',
        provider: coordinatorProvider,
        bus,
        logger,
        executionLayer,
        pinnedSkills: ['delegate'],
        skillToolDefs: toolDefs,
      });
      coordinator.register();

      const setupWizard = new AgentRuntime({
        agentId: 'setup-wizard',
        systemPrompt: 'You are a setup specialist.',
        provider: setupWizardProvider,
        bus,
        logger,
      });
      setupWizard.register();

      let finalResponse = '';
      bus.subscribe('agent.response', 'system', async (event) => {
        if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
          finalResponse = event.payload.content;
        }
      });

      const task = createAgentTask({
        agentId: 'coordinator',
        conversationId: 'test-conv-kickoff',
        channelId: 'test',
        senderId: 'test-user',
        content: KICKOFF_TEXT,
        parentEventId: 'test-inbound-kickoff',
      });
      await bus.publish('dispatch', task);

      expect(specialistCalls).toBe(1);
      expect(coordinatorCalls).toBe(2);
      expect(finalResponse).toContain('setup-wizard responded');
    });

    it('coordinator does NOT delegate to setup-wizard for a normal greeting', async () => {
      const { bus, executionLayer, skillRegistry } = makeSetup();

      let specialistCalls = 0;
      const setupWizardProvider: LLMProvider = {
        id: 'mock-setup-wizard',
        chat: async () => {
          specialistCalls++;
          return {
            type: 'text' as const,
            content: 'Should not be called.',
            usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        },
      };

      const coordinatorProvider: LLMProvider = {
        id: 'mock-coordinator',
        chat: async () => ({
          // Coordinator handles a normal greeting directly — no tool call.
          type: 'text' as const,
          content: 'Hello! How can I help you today?',
          usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        }),
      };

      const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

      const coordinator = new AgentRuntime({
        agentId: 'coordinator',
        systemPrompt: 'You are a coordinator.',
        provider: coordinatorProvider,
        bus,
        logger,
        executionLayer,
        pinnedSkills: ['delegate'],
        skillToolDefs: toolDefs,
      });
      coordinator.register();

      const setupWizard = new AgentRuntime({
        agentId: 'setup-wizard',
        systemPrompt: 'You are a setup specialist.',
        provider: setupWizardProvider,
        bus,
        logger,
      });
      setupWizard.register();

      const task = createAgentTask({
        agentId: 'coordinator',
        conversationId: 'test-conv-normal',
        channelId: 'test',
        senderId: 'test-user',
        content: 'Hello',
        parentEventId: 'test-inbound-normal',
      });
      await bus.publish('dispatch', task);

      // setup-wizard must never have been invoked.
      expect(specialistCalls).toBe(0);
    });
  });
  ```

- [ ] **Step 5.2: Run the integration test**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run test -- tests/integration/setup-wizard-delegate.test.ts
  ```

  Expected: both tests PASS.

- [ ] **Step 5.3: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add tests/integration/setup-wizard-delegate.test.ts
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "test(integration): setup-wizard delegation routing (#486)"
  ```

---

## Task 6: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 6.1: Add entries under `## [Unreleased]`**

  Open `CHANGELOG.md` and add under the `### Added` section of `## [Unreleased]`:

  ```markdown
  - **`setup-wizard` specialist** — first-conversation agent that interviews the principal, captures behavioral preferences, and guides feature setup.
  - **`behavioral-preferences-update` skill** — appends or replaces entries in `OfficeIdentity.behavioralPreferences` via `OfficeIdentityService` (`action_risk: low`).
  - **Chat auto-kickoff** — chat page auto-sends a visible kickoff message on first mount when `curia:onboarding:welcome-banner-pending` is set and no conversation exists.
  ```

- [ ] **Step 6.2: Commit**

  ```bash
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard add CHANGELOG.md
  git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard commit -m "chore: CHANGELOG entries for setup-wizard v1 (#486)"
  ```

---

## Final verification

- [ ] **Run the full test suite**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run test
  ```

  Expected: all tests pass, no regressions.

- [ ] **Run typecheck one last time**

  ```bash
  pnpm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-setup-wizard run typecheck
  ```

  Expected: no errors.

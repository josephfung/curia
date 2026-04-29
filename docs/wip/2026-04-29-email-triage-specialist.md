# Email Triage Specialist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the observation-mode email triage protocol from the coordinator into a dedicated `email-triage` specialist agent, so triage decisions are auditable in isolation and the coordinator's context window is freed for other responsibilities.

**Architecture:** Coordinator-as-hub (Approach A). The dispatcher continues routing observation-mode messages to the coordinator unchanged. The coordinator recognizes the `[OBSERVATION MODE]` flag and delegates immediately to the `email-triage` specialist via the `delegate` skill. The specialist triages, acts, and returns a structured response including the classification keyword. The coordinator echoes the keyword in its own response so the dispatcher's existing regex extraction at `src/dispatch/dispatcher.ts:779–782` continues to work without modification. Zero dispatcher changes.

**Tech Stack:** TypeScript (ESM), Vitest, YAML agent config, `interpolateRuntimeContext` from `src/agents/loader.ts`, `AgentRuntime` from `src/agents/runtime.ts`.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/agents/loader.ts` | Modify | Add `inject_specialists?: boolean` to `AgentYamlConfig` |
| `src/index.ts` | Modify | Inject `${available_specialists}` for agents with `inject_specialists: true` |
| `agents/email-triage.yaml` | Create | New specialist agent definition with triage protocol |
| `agents/coordinator.yaml` | Modify | Remove ~45 lines of triage protocol, add ~15 lines of delegation rule |
| `tests/integration/email-triage-delegation.test.ts` | Create | End-to-end test: observation-mode → coordinator delegates → specialist triages → coordinator echoes |
| `CHANGELOG.md` | Modify | Add entry under `## [Unreleased]` |

---

### Task 1: Add `inject_specialists` field to `AgentYamlConfig`

**Files:**
- Modify: `src/agents/loader.ts:15-55`

The `${available_specialists}` placeholder is currently only injected for `role: coordinator` agents (`src/index.ts:817`). The email-triage specialist needs this list to determine what's ACTIONABLE and to name the right specialist in bullpen threads. This task adds the opt-in YAML field and wires up the injection in `src/index.ts`.

- [ ] **Step 1: Add the field to the type**

In `src/agents/loader.ts`, add `inject_specialists?: boolean` to `AgentYamlConfig` after the `error_budget` field:

```typescript
export interface AgentYamlConfig {
  name: string;
  role?: string;
  description?: string;
  persona?: {
    display_name?: string;
    tone?: string;
    title?: string;
    email_signature?: string;
  };
  model: {
    provider: string;
    model: string;
    fallback?: {
      provider: string;
      model: string;
    };
  };
  system_prompt: string;
  pinned_skills?: string[];
  allow_discovery?: boolean;
  memory?: {
    scopes?: string[];
  };
  schedule?: Array<{
    cron: string;
    task: string;
    agent_id?: string;
    expectedDurationSeconds?: number;
  }>;
  expected_duration_seconds?: number;
  error_budget?: {
    max_turns?: number;
    max_cost_usd?: number;
    max_errors?: number;
  };
  /**
   * When true, ${available_specialists} in the system_prompt is replaced at bootstrap
   * with the list of registered specialist agents. Used by specialists that need to
   * know what other agents are available (e.g. to make ACTIONABLE routing decisions).
   */
  inject_specialists?: boolean;
}
```

- [ ] **Step 2: Update the injection condition in `src/index.ts`**

Find the block starting at line 817 (`if (agentConfig.role === 'coordinator')`). The current code:

```typescript
let systemPrompt = agentConfig.system_prompt;
if (agentConfig.role === 'coordinator') {
  systemPrompt = interpolateRuntimeContext(systemPrompt, {
    availableSpecialists: agentRegistry.specialistSummary(),
    agentContactId: agentIdentityContactId,
  });
}
```

Replace with:

```typescript
let systemPrompt = agentConfig.system_prompt;
if (agentConfig.role === 'coordinator') {
  // Coordinator gets specialist list + its own contact ID.
  systemPrompt = interpolateRuntimeContext(systemPrompt, {
    availableSpecialists: agentRegistry.specialistSummary(),
    agentContactId: agentIdentityContactId,
  });
} else if (agentConfig.inject_specialists) {
  // Specialists that need to know about available agents (e.g. email-triage)
  // opt in via inject_specialists: true in their YAML.
  systemPrompt = interpolateRuntimeContext(systemPrompt, {
    availableSpecialists: agentRegistry.specialistSummary(),
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles clean**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist run build
```

Expected: no errors. If the build script does not exist, run:
```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist run typecheck
```

- [ ] **Step 4: Run tests to verify nothing regressed**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test
```

Expected: `1667 passed` (same as baseline). The `inject_specialists` field is optional and defaults to `undefined`, which is falsy — no existing agent is affected.

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist add src/agents/loader.ts src/index.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist commit -m "feat: add inject_specialists opt-in for specialist agents"
```

---

### Task 2: Create `agents/email-triage.yaml`

**Files:**
- Create: `agents/email-triage.yaml`

- [ ] **Step 1: Create the agent YAML**

Create `agents/email-triage.yaml` with the following content:

```yaml
name: email-triage
role: specialist
description: >
  Triages the CEO's inbound email in observation mode. Classifies each message into five
  categories and takes appropriate action: archives noise, saves draft replies, escalates
  urgent items via bullpen, and handles or routes actionable items.
model:
  provider: anthropic
  model: claude-sonnet-4-6
inject_specialists: true
pinned_skills:
  - email-list
  - email-get
  - email-archive
  - email-draft-save
  - entity-context
  - bullpen
allow_discovery: false
memory:
  scopes: [email-triage]
system_prompt: |
  You are the email triage specialist for an executive assistant team. You monitor the
  CEO's inbound email in observation mode and act on each message according to the
  triage protocol below.

  You are NOT the sender's intended recipient and you are NOT the coordinator. Your
  response is logged for audit purposes only — it is not sent to anyone. The coordinator
  will read your response and echo your classification keyword in its own reply.

  ## Context

  The coordinator delegates observation-mode emails to you with this structure:

    [OBSERVATION MODE — email-triage delegation]
    Message ID: <nylasMessageId>
    Account: <accountId>
    Timezone: <IANA timezone>

    --- Original message ---
    <email content>

  Always use the Account value for all email skill `account` parameters. Always use
  the Message ID for `reply_to_message_id` and archive calls.

  ## ACTIONABLE Scope

  Do NOT enumerate a fixed list of action types. Instead:
  1. Check the available specialists below to understand what Curia can currently do.
  2. If a deployed specialist can handle this task, classify as ACTIONABLE and open
     a bullpen thread mentioning that specialist by name with a clear handoff summary.
  3. If the task is within your own skill set (email archive, draft save), execute directly.
  4. If no deployed specialist can handle it and it's outside your skill set, prefer
     LEAVE FOR CEO unless the CEO has a global standing instruction that says otherwise.

  Available specialists:
  ${available_specialists}

  ## Triage Protocol

  TRIAGE — evaluate in order:

  1. STANDING INSTRUCTIONS
     Call entity-context on the sender. Check for:
     - Per-sender instructions: e.g. "always archive receipts from Stripe"
     - Global/topic instructions: e.g. "track all business expenses", "file health claims"
     If a matching standing instruction exists, follow it verbatim. The categories below
     are the fallback when no standing instruction applies.

  2. CLASSIFY — five mutually exclusive categories, evaluated in priority order:

     URGENT — time-sensitive, CEO decision required, from a known contact:
       Open a bullpen thread mentioning the coordinator. Frame it as "this email needs
       urgent attention" — do NOT specify which channel to use; the coordinator decides.
       Include: sender name, subject, one-sentence summary, key ask or deadline.
       Do NOT reply to the sender.

     ACTIONABLE — a task Curia can handle autonomously (see ACTIONABLE Scope above):
       If in-domain (email archive, draft), execute directly.
       If out-of-domain, open a bullpen thread mentioning the capable specialist.
       No CEO notification needed — it will appear in the activity log.

     NEEDS DRAFT — a reply is warranted and the CEO should review before sending:
       Call email-draft-save with:
         account: <Account from context>
         reply_to_message_id: <Message ID from context>
         triage_classification: "NEEDS DRAFT"
       Write the draft in the CEO's voice, not the assistant's. Do not sign with a
       name or title. Check whether the CEO has already replied in the thread before
       drafting.

     LEAVE FOR CEO — personal, sensitive, relationship-dependent, or uncertain:
       Do nothing. No archive, no draft, no notification.

     NOISE — receipt, newsletter, automated notification, no human action needed:
       Call email-archive with:
         message_id: <Message ID from context>
         account: <Account from context>
       No other action, no notification.

  3. WHEN IN DOUBT
     Prefer LEAVE FOR CEO. URGENT only for genuinely time-sensitive items with a clear
     deadline or decision required. Do not over-notify.

  ## Response Format

  Every response must include these three lines:

    Classification: <URGENT|ACTIONABLE|NEEDS DRAFT|LEAVE FOR CEO|NOISE>
    Rationale: <one or two sentences explaining the decision>
    Actions taken: <brief list of skill calls made, or "none">

  The coordinator reads this and echoes the classification keyword so the dispatcher
  can track it. Keep the rest of your response concise.
```

- [ ] **Step 2: Run tests to verify the new YAML loads cleanly**

The agent registry scans the `agents/` directory at boot. The test suite uses real file reads in some paths. Run:

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test
```

Expected: still `1667 passed`. The new agent file will be picked up at runtime but doesn't affect existing tests.

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist add agents/email-triage.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist commit -m "feat: add email-triage specialist agent"
```

---

### Task 3: Update `agents/coordinator.yaml`

**Files:**
- Modify: `agents/coordinator.yaml`

Remove the observation-mode triage protocol from the coordinator and replace it with a thin delegation rule. Three distinct edits.

**Edit A — Trim Inbox Disambiguation (lines 272–283)**

The current section has five bullets. Remove the two observation-mode-specific bullets (bullets 4 and 5) since the coordinator no longer processes observed emails. Keep bullets 1–3 for interactive-mode inbox references.

Current block (lines 272–283):

```
  ## Inbox Disambiguation
  Some email accounts are connected in observation mode — Curia monitors them on behalf
  of the CEO but is not the intended recipient. When the CEO says "my inbox" or "my
  email", resolve it as follows:

  - **"my inbox"** (the CEO speaking to you directly) → the CEO's own monitored inbox
  - **"your inbox"** (the CEO speaking to you directly) → Curia's own email account
  - **"Curia's inbox"** → Curia's own email account
  - **"your inbox"** (in an observed third-party email) → the CEO's monitored inbox;
    the sender is addressing the CEO, not Curia
  - **"my inbox"** (in an observed third-party email) → that sender's own inbox;
    Curia has no access to it — decline or ask the CEO to clarify
```

Replace with:

```
  ## Inbox Disambiguation
  When the CEO says "my inbox" or "my email", resolve it as follows:

  - **"my inbox"** (the CEO speaking to you directly) → the CEO's own monitored inbox
  - **"your inbox"** (the CEO speaking to you directly) → Curia's own email account
  - **"Curia's inbox"** → Curia's own email account
```

- [ ] **Step 1: Apply Edit A**

Find the `## Inbox Disambiguation` section in `agents/coordinator.yaml` and replace it with the trimmed version above (removing the two observation-mode bullets and the opening sentence referencing observation mode).

**Edit B — Remove the Observation Mode section (lines 299–339)**

Remove the entire `## Observation Mode — Monitored Inboxes` section, including:
- The preamble (lines 301–307)
- The TRIAGE protocol (lines 309–335)
- The CEO voice rule (lines 337–338)

The `${executive_voice_block}` placeholder on line 341 stays — it follows the removed section and is for interactive-mode voice guidance.

- [ ] **Step 2: Apply Edit B**

Remove all content from `## Observation Mode — Monitored Inboxes` up to (but not including) `${executive_voice_block}`. The result should be that `${executive_voice_block}` directly follows the Calendar Disambiguation section.

**Edit C — Simplify the email-skill account override (lines 357–373)**

The current block has 3 rules. Rule 1 is observation-mode specific and moves to the specialist. Remove it; renumber rules 2 and 3 to 1 and 2.

Current block:

```
  **Exception — email skills (`email-list`, `email-get`, `email-draft-save`,
  `email-archive`):**
  The `account` param on these skills selects which mailbox to operate on.
  The "default to yourself" rule does NOT apply to email-skill account selection.
  Use these rules IN ORDER:

  1. If an observation-mode preamble is present, use the Account identifier
     from that preamble.
  2. If the CEO asks you to draft, read, or archive emails in THEIR inbox,
     use the CEO's account name — not yours. "Draft this from me",
     "check my email", "draft an email for me to send", "save a draft
     for me to review" all mean the CEO's account. The CEO does not want
     drafts appearing in Curia's outbox — they want them in their own
     drafts folder so they can review and send.
  3. If operating on your own inbox (Curia's messages, Curia's drafts),
     use your own account or omit the param.

  When in doubt about whose mailbox to target, ask the CEO.
```

Replace with:

```
  **Exception — email skills (`email-list`, `email-get`, `email-draft-save`,
  `email-archive`):**
  The `account` param on these skills selects which mailbox to operate on.
  The "default to yourself" rule does NOT apply to email-skill account selection.
  Use these rules IN ORDER:

  1. If the CEO asks you to draft, read, or archive emails in THEIR inbox,
     use the CEO's account name — not yours. "Draft this from me",
     "check my email", "draft an email for me to send", "save a draft
     for me to review" all mean the CEO's account. The CEO does not want
     drafts appearing in Curia's outbox — they want them in their own
     drafts folder so they can review and send.
  2. If operating on your own inbox (Curia's messages, Curia's drafts),
     use your own account or omit the param.

  When in doubt about whose mailbox to target, ask the CEO.
```

- [ ] **Step 3: Apply Edit C**

Find the "Exception — email skills" block and replace with the trimmed 2-rule version above.

**Edit D — Add observation-mode delegation rule**

In the `## Your Team` section (around line 382), add a subsection immediately before `Available specialists:` that instructs the coordinator to delegate observation-mode emails:

```
  ## Observation-Mode Email Triage

  When you receive a message containing `[OBSERVATION MODE — monitored inbox]`, delegate
  immediately to the `email-triage` specialist via the delegate tool. Do not triage the
  email yourself.

  Pass this task string to email-triage (substitute the values from the preamble):

    [OBSERVATION MODE — email-triage delegation]
    Message ID: <nylasMessageId from preamble>
    Account: <Account identifier from preamble>
    Timezone: <timezone from your current context>

    --- Original message ---
    <paste the full email content, preserving the [OBSERVATION MODE] preamble>

  After email-triage responds, include its classification keyword verbatim in your own
  response (e.g. `Classification: NOISE`) so it can be tracked.

  If the email-triage specialist is unavailable (delegate returns an error), respond with
  `Classification: LEAVE FOR CEO` and note that the triage specialist was unavailable.
  Do not attempt to triage the email yourself.
```

- [ ] **Step 4: Apply Edit D**

Add this block inside the `## Your Team` section, before the `Available specialists:` line and `${available_specialists}` placeholder.

- [ ] **Step 5: Run tests to confirm nothing regressed**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test
```

Expected: still passing. The coordinator YAML changes affect only LLM prompt content, not any TypeScript code paths tested by the suite.

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist add agents/coordinator.yaml
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist commit -m "feat: coordinator delegates observation-mode email to email-triage specialist"
```

---

### Task 4: Integration test — observation-mode delegation chain

**Files:**
- Create: `tests/integration/email-triage-delegation.test.ts`

This test verifies the full routing chain using mock LLMs:
1. Coordinator receives an observation-mode message → calls `delegate` targeting `email-triage`
2. Email-triage receives the delegation → returns a structured response with a classification keyword
3. Coordinator echoes the classification in its own response
4. Dispatcher sees the coordinator's response and extracts the classification correctly

- [ ] **Step 1: Write the failing test**

Create `tests/integration/email-triage-delegation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { SkillManifest } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Observation-mode preamble that the dispatcher injects into the task content.
const OBS_PREAMBLE = `[OBSERVATION MODE — monitored inbox]
Message ID: msg-abc123
Account: ceo-inbox

--- Original message ---
From: investor@example.com
Subject: Quick call today?
Body: Hey, can we jump on a call today to discuss the board situation? It's urgent.`;

describe('Email-triage delegation integration', () => {
  it('coordinator delegates observation-mode email to email-triage and echoes classification', async () => {
    // 1. Set up registries
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('email-triage', {
      role: 'specialist',
      description: 'Triages the CEO inbound email in observation mode',
    });

    const skillRegistry = new SkillRegistry();
    const delegateManifest: SkillManifest = {
      name: 'delegate',
      description: 'Delegate a task to a specialist agent',
      version: '1.0.0',
      sensitivity: 'normal',
      capabilities: ['bus', 'agentRegistry'],
      inputs: { agent: 'string', task: 'string', conversation_id: 'string?' },
      outputs: { response: 'string', agent: 'string' },
      permissions: [],
      secrets: [],
      timeout: 120000,
    };
    skillRegistry.register(delegateManifest, new DelegateHandler());

    // 2. Set up bus and execution layer
    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // 3. Mock coordinator LLM:
    //    - Turn 1: receives observation-mode message, calls delegate('email-triage', ...)
    //    - Turn 2: receives delegation result, echoes classification in response
    let coordinatorCalls = 0;
    let capturedDelegateInput: { agent?: string; task?: string } = {};
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          // First turn: delegate to email-triage
          const delegateInput = {
            agent: 'email-triage',
            task: `[OBSERVATION MODE — email-triage delegation]
Message ID: msg-abc123
Account: ceo-inbox
Timezone: America/Toronto

--- Original message ---
From: investor@example.com
Subject: Quick call today?
Body: Hey, can we jump on a call today to discuss the board situation? It's urgent.`,
            conversation_id: 'email:thread-obs-1',
          };
          capturedDelegateInput = delegateInput;
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-delegate-1', name: 'delegate', input: delegateInput }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        // Turn 2: specialist responded — echo the classification
        const hasToolResult = messages.some(m =>
          Array.isArray(m.content) &&
          m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: hasToolResult
            ? 'The email-triage specialist has reviewed this message. Classification: URGENT'
            : 'Classification: LEAVE FOR CEO',
          usage: { inputTokens: 200, outputTokens: 40 },
        };
      },
    };

    // 4. Mock email-triage LLM: returns a structured triage response
    let triageSpecialistCalls = 0;
    const triageProvider: LLMProvider = {
      id: 'mock-email-triage',
      chat: async () => {
        triageSpecialistCalls++;
        return {
          type: 'text' as const,
          content: `Classification: URGENT
Rationale: Time-sensitive request from a known investor contact requesting a same-day call about a board matter.
Actions taken: bullpen thread opened mentioning coordinator`,
          usage: { inputTokens: 80, outputTokens: 40 },
        };
      },
    };

    // 5. Create both agent runtimes
    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator. Delegate observation-mode emails to email-triage.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const triageSpecialist = new AgentRuntime({
      agentId: 'email-triage',
      systemPrompt: 'You are the email-triage specialist.',
      provider: triageProvider,
      bus,
      logger,
    });
    triageSpecialist.register();

    // 6. Capture coordinator's final response
    let coordinatorFinalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        coordinatorFinalResponse = event.payload.content;
      }
    });

    // 7. Send an observation-mode task to the coordinator
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-obs-1',
      channelId: 'email',
      senderId: 'investor@example.com',
      content: OBS_PREAMBLE,
      parentEventId: 'inbound-obs-event-1',
    });
    await bus.publish('dispatch', task);

    // 8. Verify the full delegation loop ran
    expect(coordinatorCalls).toBe(2); // coordinator was called twice (delegate + synthesize)
    expect(triageSpecialistCalls).toBe(1); // email-triage specialist was called
    expect(capturedDelegateInput.agent).toBe('email-triage'); // coordinator targeted the right agent
    expect(capturedDelegateInput.task).toContain('msg-abc123'); // Message ID forwarded
    expect(capturedDelegateInput.task).toContain('ceo-inbox'); // Account forwarded

    // 9. Verify coordinator echoed the classification keyword
    expect(coordinatorFinalResponse).toContain('Classification: URGENT');
  });

  it('coordinator responds with LEAVE FOR CEO when email-triage is unavailable', async () => {
    // Scenario: email-triage is not registered — delegate skill returns an error.
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    // email-triage intentionally NOT registered

    const skillRegistry = new SkillRegistry();
    const delegateManifest: SkillManifest = {
      name: 'delegate',
      description: 'Delegate a task to a specialist agent',
      version: '1.0.0',
      sensitivity: 'normal',
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

    // Coordinator: first turn tries to delegate, second turn gets tool error and falls back
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator-fallback',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-delegate-fail',
              name: 'delegate',
              input: { agent: 'email-triage', task: 'triage this email', conversation_id: 'email:thread-obs-2' },
            }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        // Turn 2: delegate failed — fall back to LEAVE FOR CEO
        return {
          type: 'text' as const,
          content: 'Classification: LEAVE FOR CEO — triage specialist was unavailable.',
          usage: { inputTokens: 150, outputTokens: 30 },
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

    let coordinatorFinalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        coordinatorFinalResponse = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-obs-2',
      channelId: 'email',
      senderId: 'investor@example.com',
      content: OBS_PREAMBLE,
      parentEventId: 'inbound-obs-event-2',
    });
    await bus.publish('dispatch', task);

    expect(coordinatorCalls).toBe(2); // attempted delegate, then fell back
    expect(coordinatorFinalResponse).toContain('Classification: LEAVE FOR CEO');
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes**

This test is written after Tasks 1–3 are already complete (see Implementation Order note at the bottom). Run it now:

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test tests/integration/email-triage-delegation.test.ts
```

Expected: PASS (both tests). The mock LLMs bypass real LLM calls; the test is exercising the delegation infrastructure only.

- [ ] **Step 3: Run the full test suite**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test
```

Expected: `1669 passed` (1667 baseline + 2 new integration tests).

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist add tests/integration/email-triage-delegation.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist commit -m "test: integration test for email-triage delegation chain"
```

---

### Task 5: Verify existing dispatcher-observation-triage tests still pass

**Files:**
- No changes — `tests/unit/dispatch/dispatcher-observation-triage.test.ts` is read-only in this task

The dispatcher-observation-triage tests verify that the dispatcher correctly extracts the classification keyword from the coordinator's `agent.response` event. These tests should pass without any changes because:
- The coordinator still emits classification keywords (it echoes from the specialist)
- The dispatcher's regex extraction code is unchanged
- The test stubs bypass the coordinator entirely (they inject the `agent.response` event directly)

- [ ] **Step 1: Run the observation-triage tests explicitly**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist test tests/unit/dispatch/dispatcher-observation-triage.test.ts
```

Expected: All 7 tests pass. If any fail, they indicate a regression in the dispatcher code — diagnose before proceeding.

---

### Task 6: Update CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry under `## [Unreleased]`**

Open `CHANGELOG.md` and add the following under `## [Unreleased]`:

```markdown
### Added
- **email-triage specialist agent** (`agents/email-triage.yaml`): new specialist that owns
  observation-mode inbox triage end-to-end. Classifies inbound email into five categories
  (URGENT, ACTIONABLE, NEEDS DRAFT, LEAVE FOR CEO, NOISE), executes email-domain actions
  directly, and routes out-of-domain ACTIONABLE items via bullpen. Capability-aware:
  consults the available-specialists list to determine the current ACTIONABLE scope rather
  than hardcoding action types.
- **`inject_specialists` YAML field**: opt-in mechanism for specialist agents that need the
  `${available_specialists}` runtime injection (previously coordinator-only).

### Changed
- **Coordinator**: removed ~45 lines of observation-mode triage protocol; replaced with a
  ~15-line delegation rule that immediately hands off `[OBSERVATION MODE]` messages to the
  `email-triage` specialist. Coordinator echoes the classification keyword in its own
  response so the dispatcher's classification extraction is unchanged.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist add CHANGELOG.md
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-email-triage-specialist commit -m "chore: update CHANGELOG for email-triage specialist"
```

---

## Implementation Order

Execute tasks in this order. Each task leaves the test suite passing before the next begins:

1. Task 1 (inject_specialists type + runtime)
2. Task 2 (create email-triage.yaml)
3. Task 3 (update coordinator.yaml)
4. Task 4 (write integration test — write after Tasks 1–3 so it can pass immediately)
5. Task 5 (verify dispatcher-observation-triage tests unchanged)
6. Task 6 (CHANGELOG)

> **Note on Task 4 ordering:** The writing-plans skill specifies TDD (write failing tests first). For this feature, the integration test requires all three prior components to exist before it can be meaningfully run as a passing test. Write the test file after Tasks 1–3 are complete so it passes on first run, and it serves as the regression gate going forward. The dispatcher-observation-triage.test.ts (Task 5) already covers the classification extraction path and should be run after every change as the regression anchor.

---

## Files to Create / Modify (Summary)

| File | Task | Change |
|------|------|--------|
| `src/agents/loader.ts` | 1 | Add `inject_specialists?: boolean` to `AgentYamlConfig` |
| `src/index.ts` | 1 | Inject specialists for `inject_specialists: true` agents |
| `agents/email-triage.yaml` | 2 | Create specialist agent |
| `agents/coordinator.yaml` | 3 | Remove ~45 lines triage protocol, add ~15 lines delegation rule |
| `tests/integration/email-triage-delegation.test.ts` | 4 | Create integration test |
| `CHANGELOG.md` | 6 | Add unreleased entries |

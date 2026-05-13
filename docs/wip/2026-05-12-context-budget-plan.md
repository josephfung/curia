# Context Budget Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a token-aware budgeting layer that wraps existing context assembly, measures per-tier token cost, enforces inclusion/exclusion based on available budget, and emits observability events.

**Architecture:** A `ContextBudget` class wraps the existing priority-ordered assembly in `runtime.ts`. A local token estimator measures each tier before inclusion. Tiers that don't fit are hard-dropped. A `context.budget` bus event is emitted after each assembly with per-tier stats, landing in `audit_log`.

**Tech Stack:** TypeScript (ESM), Vitest, Anthropic Claude models

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/agents/llm/token-estimator.ts` | Create | Token estimation function, context window map, safety margin constant |
| `src/agents/llm/context-budget.ts` | Create | `ContextBudget` class — allocation, history truncation, report generation |
| `src/bus/events.ts` | Modify | `ContextBudgetPayload`, `ContextBudgetEvent`, factory function |
| `src/agents/loader.ts` | Modify | Add `context_budget` to `AgentYamlConfig` interface |
| `src/agents/runtime.ts` | Modify | Wrap assembly with budget, emit event |
| `agents/coordinator.yaml` | Modify | Add `context_budget` config |
| `tests/unit/agents/llm/token-estimator.test.ts` | Create | Token estimator + context window tests |
| `tests/unit/agents/llm/context-budget.test.ts` | Create | Budget class tests |
| `tests/unit/agents/runtime.test.ts` | Modify | Budget integration tests |

---

### Task 1: Token Estimator — `estimateTokens` function

**Files:**
- Create: `tests/unit/agents/llm/token-estimator.test.ts`
- Create: `src/agents/llm/token-estimator.ts`

- [ ] **Step 1: Write the failing tests**

Create the test file with tests for string input, `ContentBlock[]` input, and edge cases:

```typescript
// tests/unit/agents/llm/token-estimator.test.ts
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../../src/agents/llm/token-estimator.js';
import type { ContentBlock } from '../../../../src/agents/llm/provider.js';

describe('estimateTokens', () => {
  it('estimates tokens for a plain string', () => {
    // 35 characters / 3.5 = 10 tokens
    const result = estimateTokens('The quick brown fox jumps over dogs');
    expect(result).toBe(10);
  });

  it('rounds up to the next whole token', () => {
    // 4 characters / 3.5 = 1.14... → 2
    const result = estimateTokens('test');
    expect(result).toBe(2);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens for TextContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello world' },  // 11 chars
      { type: 'text', text: 'Goodbye' },       // 7 chars
    ];
    // Total 18 chars / 3.5 = 5.14 → 6
    expect(estimateTokens(blocks)).toBe(6);
  });

  it('estimates tokens for ToolUseContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'toolu_1', name: 'web-fetch', input: { url: 'https://example.com' } },
    ];
    // Serialized: 'web-fetch' + JSON of input → count chars / 3.5
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });

  it('estimates tokens for ToolResultContent blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result data here' },
    ];
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });

  it('handles mixed content block types', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Start' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'test' } },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found it' },
    ];
    const result = estimateTokens(blocks);
    expect(result).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/token-estimator.test.ts`
Expected: FAIL — module `token-estimator.js` does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agents/llm/token-estimator.ts
//
// Local token estimation for context budget decisions.
//
// Uses a character-ratio heuristic (~3.5 chars per token for Claude's BPE
// tokenizer). Adequate for budgeting where the 5% safety margin absorbs
// estimation error. Exact counts come back in the API response and land
// in llm.call events — compare periodically to recalibrate the ratio.

import type { ContentBlock } from './provider.js';

// Claude models average ~3.5 characters per token for English text.
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate token count for a string or array of content blocks.
 *
 * For plain strings: chars / 3.5, rounded up.
 * For ContentBlock[]: serialize each block's text content, sum, then estimate.
 */
export function estimateTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') {
    if (content.length === 0) return 0;
    return Math.ceil(content.length / CHARS_PER_TOKEN);
  }

  // ContentBlock[] — extract text from each block type
  let totalChars = 0;
  for (const block of content) {
    switch (block.type) {
      case 'text':
        totalChars += block.text.length;
        break;
      case 'tool_use':
        // Tool name + serialized input
        totalChars += block.name.length + JSON.stringify(block.input).length;
        break;
      case 'tool_result':
        totalChars += block.content.length;
        break;
    }
  }

  if (totalChars === 0) return 0;
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/token-estimator.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/token-estimator.ts tests/unit/agents/llm/token-estimator.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add token estimator for context budgeting (#24)"
```

---

### Task 2: Token Estimator — `estimateMessagesTokens` and context window map

**Files:**
- Modify: `tests/unit/agents/llm/token-estimator.test.ts`
- Modify: `src/agents/llm/token-estimator.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing test file:

```typescript
import { estimateMessagesTokens, getContextWindow, DEFAULT_SAFETY_MARGIN } from '../../../../src/agents/llm/token-estimator.js';
import type { Message } from '../../../../src/agents/llm/provider.js';

describe('estimateMessagesTokens', () => {
  it('sums token estimates across messages with per-message overhead', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },    // 16 chars → ceil(16/3.5)=5, + 4 overhead = 9
      { role: 'user', content: 'Hello' },                  // 5 chars → ceil(5/3.5)=2, + 4 overhead = 6
    ];
    const result = estimateMessagesTokens(messages);
    expect(result).toBe(15);
  });

  it('returns 0 for an empty array', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it('handles messages with ContentBlock[] content', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    ];
    const result = estimateMessagesTokens(messages);
    // ceil(11/3.5)=4 + 4 overhead = 8
    expect(result).toBe(8);
  });
});

describe('getContextWindow', () => {
  it('returns 200_000 for claude-sonnet-4-6', () => {
    expect(getContextWindow('claude-sonnet-4-6')).toBe(200_000);
  });

  it('returns 200_000 for claude-opus-4-6', () => {
    expect(getContextWindow('claude-opus-4-6')).toBe(200_000);
  });

  it('returns 200_000 for claude-haiku-4-5', () => {
    expect(getContextWindow('claude-haiku-4-5')).toBe(200_000);
  });

  it('matches versioned model names via prefix', () => {
    // e.g. 'claude-haiku-4-5-20251001' should match 'claude-haiku-4-5'
    expect(getContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('falls back to sonnet window for unknown models', () => {
    expect(getContextWindow('unknown-model-v1')).toBe(200_000);
  });
});

describe('DEFAULT_SAFETY_MARGIN', () => {
  it('is 0.05 (5%)', () => {
    expect(DEFAULT_SAFETY_MARGIN).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/token-estimator.test.ts`
Expected: FAIL — `estimateMessagesTokens`, `getContextWindow`, `DEFAULT_SAFETY_MARGIN` are not exported

- [ ] **Step 3: Add the implementation**

Append to `src/agents/llm/token-estimator.ts`:

```typescript
import type { Message } from './provider.js';

// Per-message overhead: role token + structural delimiters.
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimate total tokens for an array of Message objects.
 * Adds a small per-message overhead for role/delimiter tokens.
 */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

// -- Context window map --
// Keyed by model name prefix. Follows the same longest-prefix-match pattern
// as pricing.ts so versioned model names (e.g. 'claude-haiku-4-5-20251001')
// resolve to the correct base entry.

const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
};

const SORTED_WINDOW_ENTRIES = Object.entries(CONTEXT_WINDOWS)
  .sort(([a], [b]) => b.length - a.length);

const FALLBACK_WINDOW_MODEL = 'claude-sonnet-4-6';

/**
 * Look up context window size (in tokens) for a model.
 * Uses longest-prefix match. Falls back to claude-sonnet-4-6 window for unknown models.
 */
export function getContextWindow(model: string): number {
  const entry = SORTED_WINDOW_ENTRIES.find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : CONTEXT_WINDOWS[FALLBACK_WINDOW_MODEL]!;
}

/** System-wide safety margin (5%) — compensates for token estimator inaccuracy. */
export const DEFAULT_SAFETY_MARGIN = 0.05;
```

Note: also add the `Message` import at the top of the file alongside the existing `ContentBlock` import:

```typescript
import type { ContentBlock, Message } from './provider.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/token-estimator.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/token-estimator.ts tests/unit/agents/llm/token-estimator.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add message token estimation and context window map (#24)"
```

---

### Task 3: ContextBudget — Construction and budget arithmetic

**Files:**
- Create: `tests/unit/agents/llm/context-budget.test.ts`
- Create: `src/agents/llm/context-budget.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/agents/llm/context-budget.test.ts
import { describe, it, expect } from 'vitest';
import { ContextBudget } from '../../../../src/agents/llm/context-budget.js';

describe('ContextBudget', () => {
  describe('construction', () => {
    it('computes availableBudget as contextWindow - responseReserve - safetyReserve', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200_000,
        responseReserve: 8_192,
        safetyMargin: 0.05,
      });
      // safetyReserve = ceil(200_000 * 0.05) = 10_000
      // available = 200_000 - 8_192 - 10_000 = 181_808
      expect(budget.availableBudget).toBe(181_808);
    });

    it('exposes remaining budget equal to available at start', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100_000,
        responseReserve: 4_000,
        safetyMargin: 0.10,
      });
      // safetyReserve = ceil(100_000 * 0.10) = 10_000
      // available = 100_000 - 4_000 - 10_000 = 86_000
      expect(budget.availableBudget).toBe(86_000);
      expect(budget.remaining).toBe(86_000);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: FAIL — module `context-budget.js` does not exist

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/agents/llm/context-budget.ts
//
// Token-aware context budget for agent LLM calls.
//
// Wraps the existing priority-ordered assembly in runtime.ts with
// measurement and enforcement. Each tier is independently checked
// against remaining budget — if it fits, include and deduct; if not,
// drop it and move on. System prompt is always included.
//
// See: docs/wip/2026-05-12-context-budget-design.md

import type { Message } from './provider.js';
import { estimateMessagesTokens } from './token-estimator.js';

export interface ContextBudgetConfig {
  model: string;
  contextWindow: number;
  responseReserve: number;
  safetyMargin: number;
}

export class ContextBudget {
  readonly availableBudget: number;
  remaining: number;

  private readonly config: ContextBudgetConfig;

  constructor(config: ContextBudgetConfig) {
    this.config = config;
    const safetyReserve = Math.ceil(config.contextWindow * config.safetyMargin);
    this.availableBudget = config.contextWindow - config.responseReserve - safetyReserve;
    this.remaining = this.availableBudget;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: All 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/context-budget.ts tests/unit/agents/llm/context-budget.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add ContextBudget class with budget arithmetic (#24)"
```

---

### Task 4: ContextBudget — `allocateRequired` and `allocate`

**Files:**
- Modify: `tests/unit/agents/llm/context-budget.test.ts`
- Modify: `src/agents/llm/context-budget.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `ContextBudget` describe block in the test file:

```typescript
  describe('allocateRequired', () => {
    it('always includes the tier and deducts tokens', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0, // no margin for easy math
      });
      // available = 900
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(350) }];
      // 350 chars / 3.5 = 100 tokens + 4 overhead = 104
      budget.allocateRequired('system_prompt', messages);
      expect(budget.remaining).toBe(900 - 104);
    });

    it('allows remaining to go negative on overflow without throwing', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100,
        responseReserve: 10,
        safetyMargin: 0.0,
      });
      // available = 90
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(700) }];
      // 700 / 3.5 = 200 + 4 = 204
      budget.allocateRequired('system_prompt', messages);
      expect(budget.remaining).toBe(90 - 204); // -114
    });
  });

  describe('allocate', () => {
    it('includes a tier that fits and deducts tokens', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0,
      });
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(350) }];
      const included = budget.allocate('sender_context', messages);
      expect(included).toBe(true);
      expect(budget.remaining).toBe(900 - 104);
    });

    it('drops a tier that does not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 150
      const messages: Message[] = [{ role: 'system', content: 'x'.repeat(700) }];
      // 700 / 3.5 = 200 + 4 = 204 > 150
      const included = budget.allocate('bullpen', messages);
      expect(included).toBe(false);
      expect(budget.remaining).toBe(150); // unchanged
    });

    it('drops a tier with empty messages', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 1000,
        responseReserve: 100,
        safetyMargin: 0.0,
      });
      const included = budget.allocate('bullpen', []);
      expect(included).toBe(false);
      expect(budget.remaining).toBe(900); // unchanged
    });

    it('independently evaluates tiers — a dropped tier does not block subsequent tiers', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 500,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 450
      // Large tier that won't fit
      const large: Message[] = [{ role: 'system', content: 'x'.repeat(3500) }];
      // 3500/3.5 = 1000 + 4 = 1004 > 450
      expect(budget.allocate('sender_context', large)).toBe(false);

      // Small tier that should still fit
      const small: Message[] = [{ role: 'system', content: 'x'.repeat(35) }];
      // 35/3.5 = 10 + 4 = 14 < 450
      expect(budget.allocate('bullpen', small)).toBe(true);
      expect(budget.remaining).toBe(450 - 14);
    });
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: FAIL — `allocateRequired` and `allocate` do not exist on ContextBudget

- [ ] **Step 3: Add the implementation**

Add to the `ContextBudget` class in `src/agents/llm/context-budget.ts`:

```typescript
  // Internal tier tracking
  private tiers: TierRecord[] = [];

  /**
   * Allocate a required tier (e.g. system prompt) — always included.
   * Deducts tokens from remaining even if it causes remaining to go negative.
   * Callers should log an error if remaining goes negative after this call.
   */
  allocateRequired(tierName: string, messages: Message[]): void {
    const tokens = estimateMessagesTokens(messages);
    this.remaining -= tokens;
    this.tiers.push({ name: tierName, estimatedTokens: tokens, included: true });
  }

  /**
   * Allocate an optional tier. Returns true if included, false if dropped.
   * Empty message arrays are dropped with reason 'empty'.
   * Tiers that exceed remaining budget are dropped with reason 'budget_exceeded'.
   */
  allocate(tierName: string, messages: Message[]): boolean {
    const tokens = estimateMessagesTokens(messages);

    if (tokens === 0) {
      this.tiers.push({ name: tierName, estimatedTokens: 0, included: false, droppedReason: 'empty' });
      return false;
    }

    if (tokens <= this.remaining) {
      this.remaining -= tokens;
      this.tiers.push({ name: tierName, estimatedTokens: tokens, included: true });
      return true;
    }

    this.tiers.push({ name: tierName, estimatedTokens: tokens, included: false, droppedReason: 'budget_exceeded' });
    return false;
  }
```

And add the `TierRecord` interface above the class:

```typescript
interface TierRecord {
  name: string;
  estimatedTokens: number;
  included: boolean;
  droppedReason?: 'budget_exceeded' | 'empty';
}
```

Also add the `Message` import at the top (already imported via `provider.js`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/context-budget.ts tests/unit/agents/llm/context-budget.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add allocateRequired and allocate to ContextBudget (#24)"
```

---

### Task 5: ContextBudget — `allocateHistory`

**Files:**
- Modify: `tests/unit/agents/llm/context-budget.test.ts`
- Modify: `src/agents/llm/context-budget.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `ContextBudget` describe block:

```typescript
  describe('allocateHistory', () => {
    // Helper: create a turn with a specific character length
    function turn(chars: number): Message {
      return { role: 'user', content: 'x'.repeat(chars) };
    }

    it('includes full history when it fits', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });
      // available = 9_000
      const turns = [turn(35), turn(35), turn(35)];
      // Each: ceil(35/3.5)=10 + 4 = 14. Total: 42
      const included = budget.allocateHistory(turns);
      expect(included).toHaveLength(3);
      expect(budget.remaining).toBe(9_000 - 42);
    });

    it('truncates oldest turns when full history does not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 150
      // 4 turns, each: ceil(350/3.5)=100 + 4 = 104. Total: 416 > 150
      const turns = [turn(350), turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns);
      // Only the most recent 1 turn fits (104 < 150)
      expect(included).toHaveLength(1);
      expect(included[0]).toBe(turns[3]); // most recent
    });

    it('respects minKeep — keeps at least minKeep recent turns', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 500,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 450
      // 5 turns, each 14 tokens. Total: 70. Fits easily.
      const turns = [turn(35), turn(35), turn(35), turn(35), turn(35)];
      const included = budget.allocateHistory(turns, 3);
      expect(included).toHaveLength(5); // all fit
    });

    it('drops all history when even minKeep turns do not fit', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 100,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 50
      // 3 turns, each 104 tokens. minKeep=2 → 208 > 50
      const turns = [turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns, 2);
      expect(included).toHaveLength(0);
      expect(budget.remaining).toBe(50); // unchanged
    });

    it('returns empty array for empty turns', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });
      const included = budget.allocateHistory([]);
      expect(included).toHaveLength(0);
    });

    it('defaults minKeep to 2', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 300,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 250
      // 4 turns of 104 tokens each. 416 > 250.
      // minKeep=2 → 208 < 250 → keep 2 most recent
      const turns = [turn(350), turn(350), turn(350), turn(350)];
      const included = budget.allocateHistory(turns);
      expect(included).toHaveLength(2);
      expect(included[0]).toBe(turns[2]);
      expect(included[1]).toBe(turns[3]);
    });
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: FAIL — `allocateHistory` does not exist

- [ ] **Step 3: Add the implementation**

Add to the `ContextBudget` class:

```typescript
  // History tracking for the report
  private historyTurnsTotal = 0;
  private historyTurnsIncluded = 0;

  /**
   * Allocate conversation history with partial inclusion support.
   * If full history doesn't fit, truncates oldest turns until it fits,
   * keeping at least `minKeep` most recent turns.
   * Returns the included subset (may be empty if even minKeep doesn't fit).
   */
  allocateHistory(turns: Message[], minKeep = 2): Message[] {
    this.historyTurnsTotal = turns.length;

    if (turns.length === 0) {
      this.historyTurnsIncluded = 0;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: 0, included: false, droppedReason: 'empty' });
      return [];
    }

    // Try full history first
    const fullTokens = estimateMessagesTokens(turns);
    if (fullTokens <= this.remaining) {
      this.remaining -= fullTokens;
      this.historyTurnsIncluded = turns.length;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: fullTokens, included: true });
      return turns;
    }

    // Start from minKeep most recent turns and check if they fit
    const minTurns = turns.slice(-minKeep);
    const minTokens = estimateMessagesTokens(minTurns);
    if (minTokens > this.remaining) {
      // Can't even fit minKeep turns — drop all history
      this.historyTurnsIncluded = 0;
      this.tiers.push({ name: 'conversation_history', estimatedTokens: fullTokens, included: false, droppedReason: 'budget_exceeded' });
      return [];
    }

    // Binary search between minKeep and full length to find max turns that fit.
    // Turns are chronological (oldest first); we want to keep the most recent.
    let lo = minKeep;
    let hi = turns.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const slice = turns.slice(-mid);
      if (estimateMessagesTokens(slice) <= this.remaining) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const included = turns.slice(-lo);
    const tokens = estimateMessagesTokens(included);
    this.remaining -= tokens;
    this.historyTurnsIncluded = included.length;
    this.tiers.push({ name: 'conversation_history', estimatedTokens: tokens, included: true });
    return included;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/context-budget.ts tests/unit/agents/llm/context-budget.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add allocateHistory with partial inclusion to ContextBudget (#24)"
```

---

### Task 6: ContextBudget — `getReport`

**Files:**
- Modify: `tests/unit/agents/llm/context-budget.test.ts`
- Modify: `src/agents/llm/context-budget.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `ContextBudget` describe block:

```typescript
  describe('getReport', () => {
    it('returns correct report after mixed allocation', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 10_000,
        responseReserve: 1_000,
        safetyMargin: 0.0,
      });
      // available = 9_000

      // System prompt: 350 chars → 104 tokens
      budget.allocateRequired('system_prompt', [{ role: 'system', content: 'x'.repeat(350) }]);
      // Sender context: 35 chars → 14 tokens
      budget.allocate('sender_context', [{ role: 'system', content: 'x'.repeat(35) }]);
      // History: 3 turns of 35 chars each → 42 tokens
      budget.allocateHistory([
        { role: 'user', content: 'x'.repeat(35) },
        { role: 'assistant', content: 'x'.repeat(35) },
        { role: 'user', content: 'x'.repeat(35) },
      ]);
      // Bullpen: empty → dropped
      budget.allocate('bullpen', []);

      const report = budget.getReport();
      expect(report.model).toBe('claude-sonnet-4-6');
      expect(report.contextWindow).toBe(10_000);
      expect(report.responseReserve).toBe(1_000);
      expect(report.availableBudget).toBe(9_000);
      // totalUsed = 104 + 14 + 42 = 160
      expect(report.totalUsed).toBe(160);
      expect(report.utilizationPct).toBeCloseTo(160 / 9_000, 5);
      expect(report.tiers).toHaveLength(4);
      expect(report.tiers[0]).toEqual({ name: 'system_prompt', estimatedTokens: 104, included: true });
      expect(report.tiers[1]).toEqual({ name: 'sender_context', estimatedTokens: 14, included: true });
      expect(report.tiers[2]).toEqual({ name: 'conversation_history', estimatedTokens: 42, included: true });
      expect(report.tiers[3]).toEqual({ name: 'bullpen', estimatedTokens: 0, included: false, droppedReason: 'empty' });
      expect(report.historyTurnsTotal).toBe(3);
      expect(report.historyTurnsIncluded).toBe(3);
    });

    it('reports correct utilization when tiers are dropped', () => {
      const budget = new ContextBudget({
        model: 'claude-sonnet-4-6',
        contextWindow: 200,
        responseReserve: 50,
        safetyMargin: 0.0,
      });
      // available = 150
      budget.allocateRequired('system_prompt', [{ role: 'system', content: 'x'.repeat(350) }]);
      // 104 tokens, remaining = 46
      budget.allocate('sender_context', [{ role: 'system', content: 'x'.repeat(700) }]);
      // 204 tokens > 46, dropped

      const report = budget.getReport();
      expect(report.totalUsed).toBe(104);
      expect(report.tiers[1]).toEqual({
        name: 'sender_context',
        estimatedTokens: 204,
        included: false,
        droppedReason: 'budget_exceeded',
      });
    });
  });
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: FAIL — `getReport` does not exist

- [ ] **Step 3: Add the implementation**

Add the `ContextBudgetReport` interface and `getReport` method. Export the report type since the runtime will need it for event construction.

Add above the class:

```typescript
export interface ContextBudgetReport {
  model: string;
  contextWindow: number;
  responseReserve: number;
  availableBudget: number;
  totalUsed: number;
  utilizationPct: number;
  tiers: TierRecord[];
  historyTurnsTotal: number;
  historyTurnsIncluded: number;
}
```

Add to the class:

```typescript
  /**
   * Generate the budget report for event emission.
   * totalUsed is the sum of all included tiers' estimated tokens.
   */
  getReport(): ContextBudgetReport {
    const totalUsed = this.tiers
      .filter(t => t.included)
      .reduce((sum, t) => sum + t.estimatedTokens, 0);

    return {
      model: this.config.model,
      contextWindow: this.config.contextWindow,
      responseReserve: this.config.responseReserve,
      availableBudget: this.availableBudget,
      totalUsed,
      utilizationPct: this.availableBudget > 0 ? totalUsed / this.availableBudget : 0,
      tiers: [...this.tiers],
      historyTurnsTotal: this.historyTurnsTotal,
      historyTurnsIncluded: this.historyTurnsIncluded,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/llm/context-budget.test.ts`
Expected: All 15 tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/llm/context-budget.ts tests/unit/agents/llm/context-budget.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add getReport to ContextBudget (#24)"
```

---

### Task 7: Bus Event — `ContextBudgetPayload` and factory

**Files:**
- Modify: `src/bus/events.ts`

- [ ] **Step 1: Add the payload interface**

Add after the `LlmCallPayload` interface (after line 379) in `src/bus/events.ts`:

```typescript
// ContextBudgetPayload — emitted by the agent runtime after assembling context
// for each LLM call. Reports per-tier token estimates, budget utilization, and
// which tiers were dropped. Co-located with llm.call events in audit_log for
// correlating budget utilization with actual token usage.
// Design: docs/wip/2026-05-12-context-budget-design.md
interface ContextBudgetPayload {
  agentId: string;
  conversationId: string;
  model: string;
  contextWindow: number;
  responseReserve: number;
  availableBudget: number;
  totalUsed: number;
  utilizationPct: number;
  tiers: Array<{
    name: string;
    estimatedTokens: number;
    included: boolean;
    droppedReason?: 'budget_exceeded' | 'empty';
  }>;
  historyTurnsTotal: number;
  historyTurnsIncluded: number;
}
```

- [ ] **Step 2: Add the event interface**

Add after the `LlmCallEvent` interface (after line 643):

```typescript
// ContextBudgetEvent — published by the agent layer after assembling context for each LLM call.
// parentEventId references the agent.task that triggered it.
export interface ContextBudgetEvent extends BaseEvent {
  type: 'context.budget';
  sourceLayer: 'agent';
  payload: ContextBudgetPayload;
}
```

- [ ] **Step 3: Add to the BusEvent discriminated union**

In the `BusEvent` type union, add after the `LlmCallEvent` line (line 726):

```typescript
  | ContextBudgetEvent        // #24: context budget utilization per LLM call
```

- [ ] **Step 4: Add the factory function**

Add after the `createLlmCall` factory (after line 1147):

```typescript
export function createContextBudget(
  payload: ContextBudgetPayload & { parentEventId: string },
): ContextBudgetEvent {
  const { parentEventId, ...rest } = payload;
  return {
    id: randomUUID(),
    timestamp: new Date(),
    type: 'context.budget',
    sourceLayer: 'agent',
    payload: rest,
    parentEventId,
  };
}
```

- [ ] **Step 5: Verify types compile**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/bus/events.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add context.budget event type and factory (#24)"
```

---

### Task 8: Agent Config — `context_budget` in loader and coordinator YAML

**Files:**
- Modify: `src/agents/loader.ts:15-64` — add `context_budget` to `AgentYamlConfig`
- Modify: `agents/coordinator.yaml` — add `context_budget` config block

- [ ] **Step 1: Add `context_budget` to `AgentYamlConfig`**

In `src/agents/loader.ts`, add after the `error_budget` field (after line 57):

```typescript
  /** Context budget config — controls how much of the model's context window is
   *  reserved for the response. The budgeting layer in runtime.ts uses this to
   *  enforce tier-based inclusion/exclusion. */
  context_budget?: {
    /** Tokens reserved for the model's response. Default: 8192. */
    response_reserve?: number;
  };
```

- [ ] **Step 2: Add `context_budget` to coordinator.yaml**

Add after the `error_budget` or `expected_duration_seconds` field in `agents/coordinator.yaml` (after the model block, before `system_prompt`):

```yaml
context_budget:
  response_reserve: 8192
```

- [ ] **Step 3: Verify config loads without errors**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/loader.test.ts`
Expected: All existing loader tests PASS

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/loader.ts agents/coordinator.yaml
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: add context_budget config to agent YAML schema (#24)"
```

---

### Task 9: Runtime Integration — Wire budget into assembly

**Files:**
- Modify: `src/agents/runtime.ts`

This is the core integration. The budget wraps the existing assembly flow without changing tier construction logic.

- [ ] **Step 1: Add imports to runtime.ts**

Add to the imports at the top of `src/agents/runtime.ts`:

```typescript
import { ContextBudget } from './llm/context-budget.js';
import { getContextWindow, DEFAULT_SAFETY_MARGIN } from './llm/token-estimator.js';
import { createContextBudget } from '../bus/events.js';
```

Update the existing `events.js` import to include `createContextBudget`.

- [ ] **Step 2: Add `modelName` and `contextBudget` config to `AgentConfig` interface**

In the `AgentConfig` interface (around line 22), add:

```typescript
  /** Model name from agent YAML (e.g. 'claude-sonnet-4-6'). Used by the context
   *  budget to look up the model's context window size. */
  modelName?: string;
  /** Context budget config from agent YAML. */
  contextBudget?: {
    responseReserve?: number;
  };
```

Note: `modelName` is populated from the agent YAML config's `model.model` field during bootstrap. When absent, falls back to `'claude-sonnet-4-6'`.

- [ ] **Step 3: Wire the budget into `processTask`**

The budget wraps the existing assembly. Modify `processTask()` in `runtime.ts`.

After the error budget setup (after line 307, `const budget: ErrorBudget = ...`), add:

```typescript
    // Create context budget for token-aware assembly.
    const modelName = this.config.modelName ?? 'claude-sonnet-4-6';
    const ctxBudget = new ContextBudget({
      model: modelName,
      contextWindow: getContextWindow(modelName),
      responseReserve: this.config.contextBudget?.responseReserve ?? 8_192,
      safetyMargin: DEFAULT_SAFETY_MARGIN,
    });
```

After the system prompt is fully assembled (the `effectiveSystemPrompt` variable is finalized, around line 297), add the budget registration:

```typescript
    // Register system prompt with context budget — always included
    ctxBudget.allocateRequired('system_prompt', [{ role: 'system', content: effectiveSystemPrompt }]);
    if (ctxBudget.remaining < 0) {
      logger.error(
        { agentId, remaining: ctxBudget.remaining, availableBudget: ctxBudget.availableBudget },
        'System prompt exceeds context budget — proceeding without enforcement',
      );
    }
```

After history loading (around line 312, `const history = ...`), replace the direct use of `history` with budget-gated history:

```typescript
    const budgetedHistory = ctxBudget.allocateHistory(
      history.map(t => ({ role: t.role, content: t.content })),
    );
```

Then update the messages array construction (line 315) to use `budgetedHistory`:

```typescript
    const messages: Message[] = [
      { role: 'system', content: effectiveSystemPrompt },
      ...budgetedHistory,
      { role: 'user', content },
    ];
```

After sender context injection (around line 414-451), add budget allocation for sender context. Wrap the existing sender context insertion in a budget check:

Before `messages.splice(1, 0, { role: 'system', content: senderInfo });` (line 414), replace the unconditional splice with a budget-gated one:

```typescript
      if (ctxBudget.allocate('sender_context', [{ role: 'system', content: senderInfo }])) {
        messages.splice(1, 0, { role: 'system', content: senderInfo });
        bullpenInsertAt = 2;
      }
```

Remove the original unconditional `messages.splice(1, 0, ...)` and `bullpenInsertAt = 2`.

Apply the same budget gate to the unknown-sender block (around line 448). Replace:
```typescript
        messages.splice(1, 0, { role: 'system', content: unknownSenderBlock });
        bullpenInsertAt = 2;
```
With:
```typescript
        if (ctxBudget.allocate('sender_context', [{ role: 'system', content: unknownSenderBlock }])) {
          messages.splice(1, 0, { role: 'system', content: unknownSenderBlock });
          bullpenInsertAt = 2;
        }
```

After Bullpen injection (line 458), add budget allocation. The `refreshBullpenContext` method currently injects directly into the messages array. After the refresh call, measure the injected bullpen message and record it in the budget:

```typescript
    // Record bullpen context in the budget (for observability — bullpen is already injected)
    const bullpenMsg = messages.find((m, i) => i > 0 && m.role === 'system' && m.content !== effectiveSystemPrompt && (senderCtx?.resolved ? i === 2 : i === 1));
    if (bullpenMsg) {
      ctxBudget.allocate('bullpen', [bullpenMsg]);
    } else {
      ctxBudget.allocate('bullpen', []);
    }
```

Note: a cleaner integration is to modify `refreshBullpenContext` to check the budget first, but that's a bigger refactor. For now, record the bullpen in the budget for observability. If bullpen context is too large and the budget is tight, this can be gated in a follow-up.

- [ ] **Step 4: Emit the `context.budget` event**

After all context is assembled and before the first LLM call (before line 476, `let response = await this.chatWithRetry(...)`), add:

```typescript
    // Publish context budget telemetry — captures per-tier token estimates even if
    // the LLM call subsequently fails. Wrapped in try-catch like llm.call telemetry.
    try {
      const budgetReport = ctxBudget.getReport();
      const budgetEvent = createContextBudget({
        agentId,
        conversationId,
        model: budgetReport.model,
        contextWindow: budgetReport.contextWindow,
        responseReserve: budgetReport.responseReserve,
        availableBudget: budgetReport.availableBudget,
        totalUsed: budgetReport.totalUsed,
        utilizationPct: budgetReport.utilizationPct,
        tiers: budgetReport.tiers,
        historyTurnsTotal: budgetReport.historyTurnsTotal,
        historyTurnsIncluded: budgetReport.historyTurnsIncluded,
        parentEventId: taskEvent.id,
      });
      await bus.publish('agent', budgetEvent);
    } catch (err) {
      logger.error({ err, agentId }, 'Failed to publish context.budget event — budget tracking gap');
    }
```

- [ ] **Step 5: Verify types compile**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget tsc --noEmit`
Expected: No type errors

- [ ] **Step 6: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add src/agents/runtime.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "feat: wire context budget into agent runtime assembly (#24)"
```

---

### Task 10: Integration Tests — Budget in runtime

**Files:**
- Modify: `tests/unit/agents/runtime.test.ts`

- [ ] **Step 1: Write tests for budget event emission**

Append a new describe block to the existing `tests/unit/agents/runtime.test.ts`:

```typescript
import type { ContextBudgetEvent } from '../../../src/bus/events.js';

describe('context budget', () => {
  it('emits context.budget event on every agent task', async () => {
    const provider = createMockProvider('Hello back!');
    const budgetEvents: ContextBudgetEvent[] = [];

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      bus,
      logger: createLogger('error'),
      contextBudget: { responseReserve: 8192 },
    });
    runtime.register();

    bus.subscribe('context.budget', 'test', (event) => {
      budgetEvents.push(event as ContextBudgetEvent);
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-budget-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    expect(budgetEvents).toHaveLength(1);
    const payload = budgetEvents[0]!.payload;
    expect(payload.agentId).toBe('coordinator');
    expect(payload.conversationId).toBe('conv-budget-1');
    expect(payload.contextWindow).toBeGreaterThan(0);
    expect(payload.responseReserve).toBe(8192);
    expect(payload.availableBudget).toBeGreaterThan(0);
    expect(payload.totalUsed).toBeGreaterThan(0);
    expect(payload.utilizationPct).toBeGreaterThan(0);
    expect(payload.utilizationPct).toBeLessThanOrEqual(1);
    // At minimum: system_prompt tier should be present
    expect(payload.tiers.length).toBeGreaterThanOrEqual(1);
    expect(payload.tiers[0]!.name).toBe('system_prompt');
    expect(payload.tiers[0]!.included).toBe(true);
  });

  it('includes history turn counts in the budget event', async () => {
    const provider = createMockProvider('Response');
    const budgetEvents: ContextBudgetEvent[] = [];

    // Create a runtime with working memory that has history
    const { WorkingMemory } = await import('../../../src/memory/working-memory.js');
    const mem = new WorkingMemory();
    await mem.addTurn('conv-hist', 'coordinator', { role: 'user', content: 'Earlier message' });
    await mem.addTurn('conv-hist', 'coordinator', { role: 'assistant', content: 'Earlier reply' });

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider,
      bus,
      logger: createLogger('error'),
      memory: mem,
      contextBudget: { responseReserve: 8192 },
    });
    runtime.register();

    bus.subscribe('context.budget', 'test', (event) => {
      budgetEvents.push(event as ContextBudgetEvent);
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-hist',
      channelId: 'cli',
      senderId: 'user',
      content: 'New message',
      parentEventId: 'parent-2',
    });
    await bus.publish('dispatch', task);

    expect(budgetEvents).toHaveLength(1);
    expect(budgetEvents[0]!.payload.historyTurnsTotal).toBe(2);
    expect(budgetEvents[0]!.payload.historyTurnsIncluded).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run tests/unit/agents/runtime.test.ts`
Expected: All tests PASS (both new and existing)

- [ ] **Step 3: Run the full test suite**

Run: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run`
Expected: All tests PASS — no regressions

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/worktrees/curia-context-budget add tests/unit/agents/runtime.test.ts
git -C /Users/josephfung/Projects/worktrees/curia-context-budget commit -m "test: add integration tests for context budget event emission (#24)"
```

---

## Post-Implementation

After all tasks are complete:

1. Run the full test suite one final time: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget vitest run`
2. Run the type checker: `npx --prefix /Users/josephfung/Projects/worktrees/curia-context-budget tsc --noEmit`
3. Create a PR via `gh pr create` from the `feat/context-budget` branch

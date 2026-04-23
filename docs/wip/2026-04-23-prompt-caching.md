# Prompt Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two Anthropic prompt-cache breakpoints to `AnthropicProvider` — one on the system block and one on the last tool definition — so the ~15K tokens of static content are cached across calls within the 5-minute TTL.

**Architecture:** All changes are confined to `src/agents/llm/anthropic.ts`. The system prompt is converted from a plain string to a single `TextBlockParam` with `cache_control: { type: 'ephemeral' }`. The last element of the mapped tools array gets the same cache marker. No interface changes.

**Tech Stack:** TypeScript (ESM), `@anthropic-ai/sdk`, Vitest

---

## File Map

| File | Action |
|---|---|
| `src/agents/llm/anthropic.ts` | Modify — add cache breakpoints to system and last tool |
| `src/agents/llm/anthropic.test.ts` | Create — tests asserting cache_control placement |

---

### Task 1: Write failing tests for prompt cache markers

**Files:**
- Create: `src/agents/llm/anthropic.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// anthropic.test.ts — verifies cache_control placement in API calls.
//
// We mock the Anthropic SDK client so tests run without a real API key.
// The mock captures every call to client.messages.create() and lets us
// assert exactly what parameters were sent.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

// mockCreate is a module-level spy so individual tests can inspect calls.
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Minimal pino-shaped logger — only the methods AnthropicProvider calls.
const mockLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
};

// A valid text-only Anthropic API response. Used as the default mock return.
const makeTextResponse = () => ({
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: 'end_turn',
});

describe('AnthropicProvider — prompt caching', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(makeTextResponse());
  });

  it('passes system content as TextBlockParam[] with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('omits system key entirely when no system messages', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.system).toBeUndefined();
  });

  it('concatenates multiple system messages into one block with cache_control', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [
        { role: 'system', content: 'Part one.' },
        { role: 'system', content: 'Part two.' },
        { role: 'user', content: 'Hello' },
      ],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.system).toEqual([
      { type: 'text', text: 'Part one.\n\nPart two.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('adds cache_control only to the last tool when multiple tools provided', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'tool-a', description: 'First', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'tool-b', description: 'Second', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'tool-c', description: 'Third', input_schema: { type: 'object' as const, properties: {} } },
      ],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools[0].cache_control).toBeUndefined();
    expect(params.tools[1].cache_control).toBeUndefined();
    expect(params.tools[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('adds cache_control to the single tool when only one tool provided', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'only-tool', description: 'The one', input_schema: { type: 'object' as const, properties: {} } },
      ],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits tools key entirely when no tools provided', async () => {
    const provider = new AnthropicProvider('test-key', mockLogger as any);
    await provider.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const params = mockCreate.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to confirm they all fail**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching run test src/agents/llm/anthropic.test.ts
```

Expected: 6 failures — the current code passes `system` as a string and has no `cache_control` anywhere.

---

### Task 2: Implement system block caching

**Files:**
- Modify: `src/agents/llm/anthropic.ts`

- [ ] **Step 1: Add `TextBlockParam` to the SDK import**

In the import at line 16, add `TextBlockParam`:

```typescript
import type { MessageParam, ToolUseBlock, TextBlock, TextBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages.js';
```

- [ ] **Step 2: Replace the `system` string with a cached TextBlockParam array**

Find the `createParams` object (around line 109). Replace the `system` line:

```typescript
// Before:
system: systemContent || undefined,

// After:
// Wrap the concatenated system string in a TextBlockParam array with a
// cache_control breakpoint. This tells Anthropic to cache everything up
// to this block, saving ~5K tokens of system prompt cost on repeat calls.
// Omit the key entirely when there is no system content (same as before).
system: systemContent
  ? [{ type: 'text' as const, text: systemContent, cache_control: { type: 'ephemeral' as const } }]
  : undefined,
```

- [ ] **Step 3: Run the system-related tests to confirm they pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching run test src/agents/llm/anthropic.test.ts
```

Expected: 3 tests pass (`system content as TextBlockParam[]`, `omits system key`, `concatenates multiple system messages`). 3 tests still fail (the tool tests).

---

### Task 3: Implement last-tool cache breakpoint

**Files:**
- Modify: `src/agents/llm/anthropic.ts`

- [ ] **Step 1: Replace the inline `tools.map` with a named variable and add the breakpoint**

Find the block that sets `createParams.tools` (around line 121). Replace it entirely:

```typescript
// Only attach the tools array when tools are provided — the API rejects
// an empty tools array, so we omit the key entirely when there are none.
if (tools && tools.length > 0) {
  const mappedTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    // Cast required because ToolDefinition.input_schema is a narrower shape
    // than the SDK's polymorphic Tool['input_schema'] union type.
    input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
  }));
  // Mark the last tool with a cache_control breakpoint so the entire tool
  // list is captured in a single cache slot. The coordinator's tool list is
  // stable (48 pinned skills), so this achieves near-100% hit rate within
  // the 5-minute TTL and saves ~10K tokens per call.
  mappedTools[mappedTools.length - 1] = {
    ...mappedTools[mappedTools.length - 1],
    cache_control: { type: 'ephemeral' as const },
  };
  createParams.tools = mappedTools;
}
```

- [ ] **Step 2: Run all tests to confirm all 6 pass**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching run test src/agents/llm/anthropic.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
npm --prefix /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching add src/agents/llm/anthropic.ts src/agents/llm/anthropic.test.ts
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching commit -m "feat: add prompt caching to AnthropicProvider (issue #320)"
```

---

### Task 4: Update CHANGELOG and bump version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add CHANGELOG entry under `[Unreleased]`**

Read the current `CHANGELOG.md`, then add this entry under `## [Unreleased]` → `### Changed`:

```markdown
### Changed
- **Prompt caching** — `AnthropicProvider` now passes the system prompt as a cached `TextBlockParam` and marks the last tool definition with `cache_control: ephemeral`, reducing effective input token cost by 60-80% for repeat calls within the 5-minute TTL (issue #320)
```

- [ ] **Step 2: Bump version in `package.json`**

Read the current version in `package.json`. This is a performance/infrastructure fix — patch bump. Increment the patch number by 1 (e.g., `0.14.2` → `0.14.3`).

- [ ] **Step 3: Commit**

```bash
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching add CHANGELOG.md package.json
git -C /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-prompt-caching commit -m "chore: changelog and version bump for prompt caching"
```

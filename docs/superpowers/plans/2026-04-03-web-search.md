# Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `web-search` skill backed by Tavily that lets Curia run multi-turn searches and synthesise results itself.

**Architecture:** A single `SkillHandler` calls the Tavily HTTP API, normalises and truncates the results, and returns structured data. The existing `web-fetch` skill handles full-page reads; this skill handles search. Both compose naturally in the tool-use loop — Curia searches to find URLs, then fetches to read them. No pre-synthesis layer: the LLM does all reasoning.

**Tech Stack:** Tavily REST API (`https://api.tavily.com/search`), Node `fetch`, Vitest.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `skills/web-search/skill.json` | Manifest: inputs, outputs, secrets, sensitivity |
| Create | `skills/web-search/handler.ts` | Tavily call, normalisation, sanitisation |
| Create | `tests/unit/skills/web-search.test.ts` | Unit tests (mocked fetch) |
| Modify | `agents/coordinator.yaml` | Pin `web-search`, add research guidance to system prompt |

---

### Task 1: Write the failing tests

**Files:**
- Create: `tests/unit/skills/web-search.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// tests/unit/skills/web-search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSearchHandler } from '../../../skills/web-search/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  secretValue = 'tvly-test-key',
): SkillContext {
  return {
    input,
    secret: (name: string) => {
      if (name === 'tavily_api_key') return secretValue;
      throw new Error(`Unexpected secret: ${name}`);
    },
    log: logger,
  };
}

describe('WebSearchHandler', () => {
  const handler = new WebSearchHandler();

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns failure when query is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('query');
  });

  it('returns failure when query is empty string', async () => {
    const result = await handler.execute(makeCtx({ query: '' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('query');
  });

  it('returns failure when API key is missing', async () => {
    const ctx: SkillContext = {
      input: { query: 'test' },
      secret: () => { throw new Error('Secret not set'); },
      log: logger,
    };
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('API key');
  });

  it('returns structured results on success', async () => {
    const mockResponse = {
      results: [
        { title: 'Example', url: 'https://example.com', content: 'Some content', score: 0.9 },
        { title: 'Other', url: 'https://other.com', content: 'Other content', score: 0.7 },
      ],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    }));

    const result = await handler.execute(makeCtx({ query: 'ramen near King and Spadina' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: unknown[]; count: number };
      expect(data.count).toBe(2);
      expect(data.results).toHaveLength(2);
    }
  });

  it('returns empty results array when Tavily returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));

    const result = await handler.execute(makeCtx({ query: 'obscure query' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: unknown[]; count: number };
      expect(data.count).toBe(0);
      expect(data.results).toHaveLength(0);
    }
  });

  it('returns failure on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('401');
  });

  it('returns failure on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network timeout')));

    const result = await handler.execute(makeCtx({ query: 'test' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Search failed');
  });

  it('truncates long content fields to 5000 chars', async () => {
    const longContent = 'x'.repeat(10_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'Test', url: 'https://example.com', content: longContent, score: 0.9 }],
      }),
    }));

    const result = await handler.execute(makeCtx({ query: 'test', searchDepth: 'advanced' }));
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { results: Array<{ content: string }> };
      expect(data.results[0]!.content.length).toBeLessThanOrEqual(5000 + '[truncated]'.length);
    }
  });

  it('sends correct search_depth to Tavily', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await handler.execute(makeCtx({ query: 'test', searchDepth: 'advanced' }));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(options.body) as { search_depth: string };
    expect(body.search_depth).toBe('advanced');
  });

  it('defaults to basic search_depth', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }); 
    vi.stubGlobal('fetch', mockFetch);

    await handler.execute(makeCtx({ query: 'test' }));

    const [, options] = mockFetch.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(options.body) as { search_depth: string };
    expect(body.search_depth).toBe('basic');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-web-search
npx vitest run tests/unit/skills/web-search.test.ts
```

Expected: all tests fail with "Cannot find module" or similar — the handler doesn't exist yet.

---

### Task 2: Create the skill manifest

**Files:**
- Create: `skills/web-search/skill.json`

- [ ] **Step 1: Write the manifest**

```json
{
  "name": "web-search",
  "description": "Search the web using Tavily. Returns structured results with title, URL, snippet, and (for advanced depth) extracted page content. For simple lookups, one search is enough. For research tasks, call multiple times with different queries — each covering a different angle — before forming a conclusion.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "inputs": {
    "query": "string",
    "maxResults": "number?",
    "searchDepth": "string?"
  },
  "outputs": {
    "results": "array",
    "count": "number"
  },
  "permissions": ["network:search"],
  "secrets": ["tavily_api_key"],
  "timeout": 30000
}
```

---

### Task 3: Implement the handler

**Files:**
- Create: `skills/web-search/handler.ts`

- [ ] **Step 1: Write the handler**

```typescript
// handler.ts — web-search skill implementation.
//
// Calls the Tavily search API and returns structured results for the LLM
// to synthesise. All synthesis happens in Curia's LLM — this skill is a
// data bridge, not an answer generator.
//
// Two search depths:
//   basic    — fast, returns title + snippet only. Good for simple lookups.
//   advanced — slower, extracts full page content. Good for research tasks.
//
// Security: the API key is resolved via ctx.secret() (declared in manifest),
// never passed through the LLM context. Content is truncated per result to
// avoid blowing out the LLM context window.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Max characters per result's content field — keeps LLM context manageable.
const MAX_CONTENT_LENGTH = 5000;

const TAVILY_API_URL = 'https://api.tavily.com/search';

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  raw_content?: string;
  score: number;
}

interface TavilyResponse {
  results: TavilyResult[];
}

interface NormalisedResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

function truncate(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_CONTENT_LENGTH) + '[truncated]';
}

export class WebSearchHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { query, maxResults, searchDepth } = ctx.input as {
      query?: string;
      maxResults?: number;
      searchDepth?: string;
    };

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return { success: false, error: 'Missing required input: query (non-empty string)' };
    }

    // Resolve API key — declared in manifest so secret() will allow it.
    // If the env var is not set, secret() throws — we surface that as a
    // user-readable error rather than letting the exception propagate.
    let apiKey: string;
    try {
      apiKey = ctx.secret('tavily_api_key');
    } catch {
      return { success: false, error: 'Tavily API key not configured — set TAVILY_API_KEY in the environment' };
    }

    const depth = searchDepth === 'advanced' ? 'advanced' : 'basic';
    const limit = typeof maxResults === 'number' ? Math.min(maxResults, 20) : 5;

    ctx.log.info({ query, depth, limit }, 'Running web search via Tavily');

    let response: Response;
    try {
      response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: query.trim(),
          max_results: limit,
          search_depth: depth,
          // Request raw_content for advanced depth — full extracted page text
          include_raw_content: depth === 'advanced',
        }),
        signal: AbortSignal.timeout(25000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, query }, 'Tavily request failed');
      return { success: false, error: `Search failed: ${message}` };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Tavily returned HTTP ${response.status}: ${response.statusText || 'request failed'}`,
      };
    }

    let body: TavilyResponse;
    try {
      body = await response.json() as TavilyResponse;
    } catch (err) {
      return { success: false, error: 'Failed to parse Tavily response as JSON' };
    }

    // Normalise and truncate — use raw_content when available (advanced depth),
    // fall back to the snippet content field.
    const results: NormalisedResult[] = (body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: truncate(r.raw_content ?? r.content ?? ''),
      score: r.score,
    }));

    ctx.log.info({ query, resultCount: results.length }, 'Web search complete');

    return {
      success: true,
      data: { results, count: results.length },
    };
  }
}
```

- [ ] **Step 2: Run tests — they should now pass**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-web-search
npx vitest run tests/unit/skills/web-search.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add skills/web-search/skill.json skills/web-search/handler.ts tests/unit/skills/web-search.test.ts
git commit -m "feat: add web-search skill via Tavily API"
```

---

### Task 4: Update coordinator — pin skill and add research guidance

**Files:**
- Modify: `agents/coordinator.yaml`

- [ ] **Step 1: Pin web-search in the skills list**

In `agents/coordinator.yaml`, add `web-search` to the `pinned_skills` list after `web-fetch`:

```yaml
pinned_skills:
  - entity-context
  - web-fetch
  - web-search   # ← add this line
  - delegate
  # ... rest unchanged
```

- [ ] **Step 2: Add research guidance to the system prompt**

Find the `## Email` section in the system prompt. Add a new `## Research` section directly before it:

```yaml
  ## Research
  You can search the web and fetch pages to answer questions and do research.
  - For simple lookups ("find a restaurant", "what is X"), one search is enough.
  - For research tasks, run multiple targeted searches before forming a conclusion —
    each query should explore a different angle of the topic.
  - When a search result looks important, use web-fetch to read the full article
    before summarising it. Snippets can mislead.
  - Cite your sources naturally ("according to [source]...") rather than listing URLs
    at the end.
```

- [ ] **Step 3: Run the full test suite to confirm nothing broke**

```bash
cd /Users/josephfung/Projects/office-of-the-ceo/worktrees/curia-web-search
npx vitest run
```

Expected: all existing tests pass plus the new web-search tests.

- [ ] **Step 4: Commit**

```bash
git add agents/coordinator.yaml
git commit -m "feat: pin web-search skill and add research guidance to coordinator prompt"
```

---

### Task 5: Set the API key and smoke test

- [ ] **Step 1: Add `TAVILY_API_KEY` to the `.env` file**

Sign up at https://tavily.com, copy the API key, and add it to `.env`:

```
TAVILY_API_KEY=tvly-...
```

- [ ] **Step 2: Start Curia and run a simple test**

Start the server and send this message from the CLI:

```
Find me a ramen restaurant near King St and Spadina Ave in Toronto.
```

Expected: Curia responds with specific restaurant names, addresses, and hours. If it says it can't search, the skill isn't pinned correctly. If it gives results but no specific details, try `searchDepth: advanced`.

- [ ] **Step 3: Run a research test**

```
Help me understand the key differences between the geopolitical context surrounding the Apollo moon landings in 1969-1972 versus the Artemis program today. Focus on US-Russia/Soviet dynamics and the role of national prestige.
```

Expected: Curia runs 3-5 searches across different angles and synthesises a structured comparison with citations. If it runs only one search, the research guidance in the prompt needs tuning.

---

## Verification Checklist

- [ ] `tests/unit/skills/web-search.test.ts` — all tests pass
- [ ] `npx vitest run` — full suite passes
- [ ] Simple lookup works end-to-end (restaurant query)
- [ ] Deep research query produces multi-search synthesis with citations
- [ ] `web-search` appears in Curia's tool use in logs during the smoke tests

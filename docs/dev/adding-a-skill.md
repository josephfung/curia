# Adding a Skill

Skills are how agents interact with the outside world. Every capability — sending email, fetching a web page, writing to a calendar, running a search — is a skill. The execution layer sandboxes skill invocations: skills receive typed inputs and return typed outputs; they cannot publish bus events or access the database directly.

See [Adding an Agent](adding-an-agent.md) if you want to create a new agent rather than extend an existing one.

---

## Quick Start

1. Create a directory under `skills/<name>/`
2. Write `skills/<name>/skill.json` — the manifest (schema, metadata, risk declaration)
3. Write `skills/<name>/handler.ts` — the implementation
4. Write `skills/<name>/handler.test.ts` — tests
5. Pin the skill in any agent that should use it (`pinned_skills` in the agent YAML), or make it discoverable via `allow_discovery: true`
6. Restart Curia — skills are loaded from the `skills/` directory at startup

---

## Directory Layout

```
skills/
  web-search/
    skill.json        # manifest — schema, metadata, risk level
    handler.ts        # implementation
    handler.test.ts   # unit + integration tests
```

Skills are self-contained. Keep external imports minimal and declare any required secrets in the manifest.

---

## The Manifest (`skill.json`)

The manifest is the source of truth for what a skill does, what it needs, and how risky it is. The execution layer reads this before invoking the handler.

```json
{
  "name": "web-search",
  "description": "Search the web using the Brave Search API. Returns a ranked list of results with titles, URLs, and snippets. Use this for research tasks where you need current information.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "none",
  "inputs": {
    "query": "string",
    "count": "number?"
  },
  "outputs": {
    "results": "object[]",
    "total": "number"
  },
  "permissions": [],
  "secrets": ["brave_api_key"],
  "timeout": 15000
}
```

### Field Reference

#### `name` (required)

Unique identifier for the skill. Must match the directory name exactly. Used as the tool name presented to the LLM, so use lowercase kebab-case (`web-search`, not `WebSearch` or `web_search`).

#### `description` (required)

Plain-language description shown to the LLM when it decides which tool to use. Write this from the LLM's perspective — it is literally the text that helps the model decide to call this skill. Be specific about what inputs are needed and what the skill does:

```json
// Too vague:
"description": "Search the web"

// Better:
"description": "Search the web using the Brave Search API. Returns a ranked list of results with titles, URLs, and snippets. Use this for research tasks where you need current information."
```

#### `version` (required)

Semantic version string (`major.minor.patch`). Increment the major version for breaking input/output schema changes.

#### `sensitivity` (required)

Controls the elevated-skill gate in the execution layer:

| Value | Meaning |
|---|---|
| `"normal"` | Runs for any caller; no approval gate. |
| `"elevated"` | Fail-closed: only executes when the caller has `role: 'ceo'` or `channel: 'cli'`. All other callers are rejected with an authorization error. |

Use `"elevated"` for skills with serious external effects: sending emails, making external API calls that could have irreversible consequences, or exposing sensitive data. Use `"normal"` for anything else.

The elevated check is per-call, not per-agent-pair — there is no stored approval table. Every invocation of an elevated skill is checked against the caller context on the fly.

#### `action_risk` (required)

Declares the risk level of this skill's primary action. Used by the **autonomy engine** in Phase 2 to gate skill execution against the global autonomy score. All skills must declare this field — manifests without it will be rejected at startup once Phase 2 gating is wired, and it is required now so skills are correctly labeled when that goes live.

| Value | Min autonomy score | Capability class |
|---|---|---|
| `"none"` | 0 | Reads, retrieval, summarization — no external effect |
| `"low"` | 60 | Internal state writes: memory, contacts |
| `"medium"` | 70 | Outbound communications: email, messaging |
| `"high"` | 80 | Calendar writes, commitments on behalf of the CEO |
| `"critical"` | 90 | Financial, destructive, or irreversible actions |

A raw integer (0–100) may be used for precision when the named levels are too coarse. Values outside `[0, 100]` produce a validation error at skill load time.

**Phase 1 status:** `action_risk` is declared and validated at load time but not yet enforced at runtime — the hard gate is Phase 2 work.

**How Phase 2 gating will work:** When an agent calls a skill, the execution layer compares the skill's minimum required autonomy score against the live global score from `autonomy_config`. If the score is too low, the invocation returns an advisory failure (no throw, same `{ success: false, error }` shape as any other failure) and an audit event is emitted. The autonomy score is CEO-controlled via the `set-autonomy` skill. See `docs/superpowers/specs/2026-04-03-autonomy-engine-design.md` for the full design.

#### `infrastructure` (optional, default: `false`)

Marks skills that are part of Curia's core infrastructure (email, calendar, contacts, scheduling, etc.) rather than user-contributed extensions. Infrastructure skills receive additional `SkillContext` fields: `bus`, `agentRegistry`, `outboundGateway`, `schedulerService`, `entityMemory`, etc. — see the `SkillContext` reference below. Omit this field for contributed skills.

#### `inputs` (required)

Declares the input parameters the handler will receive. The execution layer validates inputs against this schema before calling the handler — invalid inputs return an error without reaching the handler.

Type syntax:
- `"string"` — required string
- `"string?"` — optional string (may be missing or `null`)
- `"number"` — required number
- `"number?"` — optional number
- `"boolean"` — required boolean
- `"object"` — required object (any shape)
- `"object?"` — optional object
- `"string[]"` — required array of strings
- `"object[]?"` — optional array of objects
- `"timestamp"` — ISO 8601 datetime string (validated as parseable date)

Example with a mix of required and optional:
```json
"inputs": {
  "calendarId": "string",
  "title": "string",
  "start": "timestamp",
  "end": "timestamp",
  "description": "string?",
  "attendees": "object[]?",
  "location": "string?"
}
```

#### `outputs` (required)

Documents the shape of a successful result. This is informational for the LLM — it helps the model understand what it will get back and how to use it. The runtime does not validate outputs against this schema.

```json
"outputs": {
  "results": "object[]",
  "total": "number"
}
```

#### `permissions` (optional, default: `[]`)

Declared capabilities required by this skill, validated at load time. Currently unused for enforcement but reserved for future sandboxing. Example future values: `"network:https"`, `"filesystem:read"`.

#### `secrets` (optional, default: `[]`)

Names of secrets this skill will access via `ctx.secret("name")`. The execution layer validates that any secret requested at runtime was declared here — undeclared secret requests are rejected with an error.

Secret names map to environment variables at runtime (e.g., `"brave_api_key"` → `BRAVE_API_KEY`). See [Secrets Access](#secrets-access) below.

```json
"secrets": ["brave_api_key"]
```

Note: Infrastructure skills (email, calendar) access Nylas clients via `ctx.outboundGateway` and `ctx.nylasCalendarClient`, which are bootstrapped at startup. These are not secrets — do not declare them in `secrets`.

#### `timeout` (optional, default: `30000`)

Per-invocation timeout in milliseconds. Skills that exceed this limit are killed and return a failure result. The task continues — the agent receives the failure and can retry or give up.

Set higher for skills that call slow external APIs. Set lower for skills that should be fast and likely have a bug if they aren't.

```json
"timeout": 120000,   // 2 minutes for a research/browse skill
"timeout": 10000     // 10 seconds for a fast lookup
```

---

## The Handler (`handler.ts`)

All handlers export a class implementing the `SkillHandler` interface. The execution layer instantiates the class at load time and calls `execute()` per invocation.

```typescript
// skills/web-search/handler.ts
import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class WebSearchHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { query, count = 10 } = ctx.input as { query: string; count?: number };

    // ctx.secret() is synchronous — no await needed
    const apiKey = ctx.secret('brave_api_key');

    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey } },
      );

      if (!response.ok) {
        return { success: false, error: `Brave Search API error: ${response.status} ${response.statusText}` };
      }

      const json = await response.json() as { web?: { results?: unknown[] }; query?: { total_count?: number } };
      const results = json.web?.results ?? [];

      return { success: true, data: { results, total: json.query?.total_count ?? results.length } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Include query in the log so failures are traceable without reading the full task
      ctx.log.error({ err, query }, 'web-search failed');
      return { success: false, error: `web-search failed: ${message}` };
    }
  }
}
```

### `SkillContext` (key fields)

```typescript
interface SkillContext {
  /** Validated input matching the manifest's inputs declaration */
  input: Record<string, unknown>;

  /** Synchronous secret access — only secrets declared in manifest.secrets are accessible.
   *  Maps name → env var (e.g. 'brave_api_key' → process.env.BRAVE_API_KEY).
   *  Throws if the name is not declared in the manifest. */
  secret(name: string): string;

  /** Scoped pino child logger (includes skill name and task ID in every line) */
  log: Logger;

  // --- Infrastructure-only fields (only populated when manifest.infrastructure: true) ---

  /** Outbound gateway — use this to send email from infrastructure skills.
   *  Never access email credentials directly; go through the gateway. */
  outboundGateway?: OutboundGateway;

  /** Nylas calendar client — for infrastructure skills that read/write calendar events */
  nylasCalendarClient?: NylasCalendarClient;

  /** Bus access — for infrastructure skills that need to publish events */
  bus?: EventBus;

  /** Scheduler service — for infrastructure skills like scheduler-create */
  schedulerService?: SchedulerService;

  /** Entity memory (knowledge graph) — for infrastructure skills that read/write long-term knowledge */
  entityMemory?: EntityMemory;

  // --- Available to all skills ---

  /** Caller identity (role, channel). Guaranteed non-null for elevated skills. */
  caller?: CallerContext;

  /** Agent persona (display name, title, email signature) from coordinator config */
  agentPersona?: AgentPersona;

  /** Browser service — warm Playwright instance for JS-rendered pages */
  browserService?: BrowserService;
}
```

See `src/skills/types.ts` for the full interface with all optional fields.

### `SkillResult`

```typescript
type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
```

**Never throw from a handler.** Skills must return errors as `{ success: false, error: string }`. An uncaught exception is caught by the execution layer and converted to a failure result, but throwing loses the structured error context you'd get from a deliberate return — and makes it harder to write tests that verify error paths.

### Secrets Access

```typescript
// Declare in manifest: "secrets": ["stripe_api_key"]
const apiKey = ctx.secret('stripe_api_key');  // synchronous — no await
```

- `ctx.secret()` is **synchronous** — it reads from environment variables at call time
- The execution layer throws if the name is not declared in `manifest.secrets`
- Secret values are never logged — the audit log records which secret was accessed, not its value
- Agents/LLMs never see secret values — only the handler has access within its execution scope

---

## Tests (`handler.test.ts`)

```typescript
// skills/web-search/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { WebSearchHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

// Use a real silent pino logger so the type is correct and log calls don't
// produce output during tests. Spy on it directly if you need to assert logging.
const logger = pino({ level: 'silent' });

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    // Synchronous — return a fixed test value for declared secrets
    secret: () => 'test-api-key',
    log: logger,
  };
}

describe('WebSearchHandler', () => {
  const handler = new WebSearchHandler();

  it('returns results on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [{ title: 'A', url: 'https://a.com' }] }, query: { total_count: 1 } }),
    }));

    const result = await handler.execute(makeCtx({ query: 'test query' }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { results: unknown[] }).results).toHaveLength(1);
    }

    vi.unstubAllGlobals();
  });

  it('returns failure result when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await handler.execute(makeCtx({ query: 'test query' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('network error');
    }
    // Verify the error was logged — silent failures are not allowed
    // (if you need to assert this, spy on logger.error before the call)

    vi.unstubAllGlobals();
  });

  it('returns failure when API responds with non-200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' }));

    const result = await handler.execute(makeCtx({ query: 'test query' }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('429');
    }

    vi.unstubAllGlobals();
  });
});
```

Run tests with:
```bash
pnpm test skills/web-search/handler.test.ts
```

Integration tests that call real external APIs should be tagged with `.integration.test.ts` and require the relevant env vars to be set. Unit tests stub `fetch` or mock infrastructure clients.

---

## Output Sanitization

The execution layer automatically sanitizes skill results before feeding them to the LLM:
- Strips XML/HTML tags that could be interpreted as system instructions
- Truncates outputs longer than 10,000 characters (configurable) with a `[truncated]` marker
- Redacts patterns matching known secret formats (API keys, tokens)
- Wraps error strings in `<tool_error>` tags to prevent injection

You do not need to sanitize in the handler — but be aware that very large outputs will be truncated. If your skill returns structured data, return only what the LLM needs.

---

## MCP Skills (Alternative)

For capabilities that already exist as MCP servers (GitHub, filesystem, Brave Search, etc.), connect them as MCP skills in `config/skills.yaml` rather than writing a local handler:

```yaml
# config/skills.yaml
mcp_servers:
  - name: github
    transport: sse
    url: https://mcp-github.example.com/sse
    permissions: ["network:github"]
```

At startup, Curia connects to each MCP server, discovers its tools via `tools/list`, and registers them in the skill registry alongside local skills. Agents don't know or care whether a tool is local or MCP.

See [Skills & Execution Spec](../specs/03-skills-and-execution.md#mcp-skills-external-servers) for recommended MCP servers.

---

## Picking the Right `action_risk`

When in doubt:

| The skill… | Use |
|---|---|
| Reads data, returns it | `"none"` |
| Writes to internal Curia state (memory, contacts) | `"low"` |
| Sends a message or email to someone external | `"medium"` |
| Creates a calendar event or books something | `"high"` |
| Moves money, deletes data, or can't be undone | `"critical"` |

When the risk is between two levels, use the higher one. It's easier to lower autonomy requirements after trust is established than to raise them after an incident.

---

## Checklist Before Opening a PR

- [ ] `action_risk` is declared in `skill.json`
- [ ] `sensitivity` matches whether the skill has external effects (remember: `"elevated"` = CEO-or-CLI-only gate)
- [ ] All optional inputs are suffixed with `?` in the manifest
- [ ] Handler exports a **class** implementing `SkillHandler`, not a bare function
- [ ] Handler never throws — all errors returned as `{ success: false, error }`
- [ ] Error message in the failure return is prefixed with the skill name (e.g. `"web-search failed: ..."`)
- [ ] `timeout` is set appropriately for the expected latency
- [ ] Tests cover the success path and at least one failure path
- [ ] Any required secrets are declared in `"secrets"` array
- [ ] Skill is pinned in at least one agent YAML (or documented as discoverable)

---

## Related Docs

- [Architecture Overview](../specs/00-overview.md) — five-layer bus model
- [Skills & Execution Spec](../specs/03-skills-and-execution.md) — full execution layer design
- [Adding an Agent](adding-an-agent.md) — wire your new skill into an agent
- [Audit & Security](../specs/06-audit-and-security.md) — what gets logged
- [Autonomy Engine Design](../superpowers/specs/2026-04-03-autonomy-engine-design.md) — how `action_risk` gates execution (Phase 2 hard gates, Phase 3 auto-adjustment)

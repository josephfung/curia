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
  email-send/
    skill.json        # manifest — schema, metadata, risk level
    handler.ts        # implementation
    handler.test.ts   # unit + integration tests
  _shared/            # shared utilities imported by multiple handlers
    nylas.ts
    google.ts
```

Skills are self-contained. Keep external imports minimal and declare any required secrets in the manifest.

---

## The Manifest (`skill.json`)

The manifest is the source of truth for what a skill does, what it needs, and how risky it is. The execution layer reads this before invoking the handler.

```json
{
  "name": "email-send",
  "description": "Send an email via the Nylas API. Provide recipient, subject, and body. Supports optional CC and reply-to fields.",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "medium",
  "infrastructure": true,
  "inputs": {
    "to": "string",
    "subject": "string",
    "body": "string",
    "cc": "string?",
    "reply_to": "string?"
  },
  "outputs": {
    "message_id": "string",
    "thread_id": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

### Field Reference

#### `name` (required)

Unique identifier for the skill. Must match the directory name exactly. Used as the tool name presented to the LLM, so use lowercase kebab-case (`email-send`, not `EmailSend` or `email_send`).

#### `description` (required)

Plain-language description shown to the LLM when it decides which tool to use. Write this from the LLM's perspective — it is literally the text that helps the model decide to call this skill. Be specific about what inputs are needed and what the skill does:

```json
// Too vague:
"description": "Send email"

// Better:
"description": "Send an email via the Nylas API. Provide recipient address, subject line, and HTML or plain-text body. Supports optional CC and reply-to."
```

#### `version` (required)

Semantic version string (`major.minor.patch`). Increment the major version for breaking input/output schema changes.

#### `sensitivity` (required)

Controls whether agents need human approval before using this skill for the first time:

| Value | Meaning |
|---|---|
| `"normal"` | Auto-approved for agents with `allow_discovery: true`. No human gate. |
| `"elevated"` | Requires one-time human approval per agent-skill pair before first use. Approval is persisted in `skill_approvals` — only prompted once. |

Use `"elevated"` for skills that have external effects: sending messages, writing to external systems, creating calendar events, making payments. Use `"normal"` for read-only or internal-state-only skills.

#### `action_risk` (required)

Declares the risk level of this skill's primary action. Used by the **autonomy engine** in Phase 2 to gate skill execution against the global autonomy score.

| Value | Min autonomy score | Capability class |
|---|---|---|
| `"none"` | 0 | Reads, retrieval, summarization — no external effect |
| `"low"` | 60 | Internal state writes: memory, contacts |
| `"medium"` | 70 | Outbound communications: email, messaging |
| `"high"` | 80 | Calendar writes, commitments on behalf of the CEO |
| `"critical"` | 90 | Financial, destructive, or irreversible actions |

A raw integer (0–100) may be used for precision when the named levels are too coarse. Values outside `[0, 100]` produce a validation error at skill load time.

**Phase 1 status:** `action_risk` is declared now but not yet enforced at runtime — the gating engine is Phase 2. Declaring it now ensures all skills are correctly labeled when gating goes live. Do not skip this field.

**How Phase 2 gating will work:** When an agent calls a skill, the execution layer will compare the skill's minimum required autonomy score against the live global score from `autonomy_config`. If the score is too low, the skill call is held and the user is notified for approval. The autonomy score is CEO-controlled and adjusted via the `set-autonomy` skill. See `docs/superpowers/specs/2026-04-03-autonomy-engine-design.md` for the full design.

#### `infrastructure` (optional, default: `false`)

Marks skills that are part of Curia's core infrastructure (email, calendar, contacts, scheduling, etc.) rather than user-contributed extensions. Infrastructure skills are loaded unconditionally at startup regardless of which agents pin them. Omit this field for contributed skills.

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
  "event": "object",
  "event_id": "string",
  "html_link": "string"
}
```

#### `permissions` (optional, default: `[]`)

Declared capabilities required by this skill, validated at load time. Currently unused for enforcement but reserved for future sandboxing. Example future values: `"network:https"`, `"filesystem:read"`.

#### `secrets` (optional, default: `[]`)

Names of secrets this skill will access via `ctx.secret("name")`. The execution layer validates that any secret requested at runtime was declared here — undeclared secret requests are rejected.

Secret names map to environment variables at runtime (e.g., `"telegram_bot_token"` → `TELEGRAM_BOT_TOKEN`). See [Secrets Access](#secrets-access) below.

```json
"secrets": ["telegram_bot_token", "slack_webhook_url"]
```

Note: Email and calendar skills use infrastructure clients (`ctx.nylasClient`, `ctx.googleClient`) bootstrapped at startup rather than the secret accessor. These do not need to be declared in `secrets`.

#### `timeout` (optional, default: `30000`)

Per-invocation timeout in milliseconds. Skills that exceed this limit are killed and return a failure result. The task continues — the agent receives the failure and can retry or give up.

Set higher for skills that call slow external APIs. Set lower for skills that should be fast and likely have a bug if they aren't.

```json
"timeout": 120000   // 2 minutes for a research/browse skill
"timeout": 10000    // 10 seconds for a fast lookup
```

---

## The Handler (`handler.ts`)

```typescript
// skills/email-send/handler.ts
import type { SkillContext, SkillResult } from '../../src/skills/types.js';

export async function execute(ctx: SkillContext): Promise<SkillResult> {
  const { to, subject, body, cc } = ctx.input as {
    to: string;
    subject: string;
    body: string;
    cc?: string;
  };

  try {
    // Use ctx.nylasClient for email (infrastructure client, not a secret)
    const message = await ctx.nylasClient.messages.send({
      to: [{ email: to }],
      subject,
      body,
      cc: cc ? [{ email: cc }] : [],
    });

    return {
      success: true,
      data: {
        message_id: message.id,
        thread_id: message.threadId,
      },
    };
  } catch (error) {
    // Skills return errors as values — never throw
    ctx.log.error({ error }, 'email-send failed');
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending email',
    };
  }
}
```

### `SkillContext`

```typescript
interface SkillContext {
  input: Record<string, unknown>;     // validated against manifest inputs
  secret(name: string): Promise<string>; // fetch a declared secret value
  log: Logger;                         // scoped pino child logger (includes skill name + task ID)
  nylasClient: NylasClient;           // email infrastructure client
  googleClient: GoogleAuth;           // Google Calendar/OAuth client
}
```

### `SkillResult`

```typescript
type SkillResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
```

**Never throw from a handler.** Skills must return errors as `{ success: false, error: string }`. An uncaught exception in a handler is caught by the execution layer and converted to a failure result, but throwing loses the structured error context you'd get from a deliberate return.

### Secrets Access

```typescript
// Declare in manifest: "secrets": ["stripe_api_key"]
const apiKey = await ctx.secret('stripe_api_key');
```

- Secret names map to environment variables: `stripe_api_key` → `STRIPE_API_KEY`
- The execution layer rejects requests for secrets not declared in the manifest
- Secret values are never logged — the audit log records which secret was accessed, not its value
- Agents/LLMs never see secret values — only the handler has access within its execution scope

---

## Tests (`handler.test.ts`)

```typescript
// skills/email-send/handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { execute } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

function makeCtx(input: Record<string, unknown>): SkillContext {
  return {
    input,
    secret: vi.fn().mockResolvedValue('test-secret'),
    log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
    nylasClient: {
      messages: {
        send: vi.fn().mockResolvedValue({ id: 'msg-123', threadId: 'thread-456' }),
      },
    } as any,
    googleClient: {} as any,
  };
}

describe('email-send', () => {
  it('returns message_id and thread_id on success', async () => {
    const ctx = makeCtx({ to: 'test@example.com', subject: 'Hello', body: 'World' });
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ message_id: 'msg-123' });
    }
  });

  it('returns failure result when Nylas throws', async () => {
    const ctx = makeCtx({ to: 'bad', subject: 'x', body: 'y' });
    (ctx.nylasClient.messages.send as any).mockRejectedValue(new Error('invalid address'));
    const result = await execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('invalid address');
    }
  });
});
```

Run tests with:
```bash
pnpm test skills/email-send/handler.test.ts
```

Integration tests that call real external APIs should be tagged with `.integration.test.ts` and require the relevant env vars to be set. Unit tests mock external clients.

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

- [ ] `action_risk` is declared in `skill.json` (even if you think it's obvious)
- [ ] `sensitivity` matches whether the skill has external effects
- [ ] All optional inputs are suffixed with `?` in the manifest
- [ ] Handler never throws — all errors returned as `{ success: false, error }`
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
- [Autonomy Engine Design](../superpowers/specs/2026-04-03-autonomy-engine-design.md) — how `action_risk` will gate execution in Phase 2

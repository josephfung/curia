# 03 — Tools & Execution Layer

## Overview

**Tools** are the framework's extension atoms — how agents interact with the outside world (invocation + authorization). The execution layer handles tool invocation, permission validation, and MCP protocol. Per ADR-031 / #1485, the former "skill" atom name is **tool**; the *skill* layer is the collection/bundle unit (shipped in Phase 2 — #1489), which the Skill Discovery & Activation section below describes.

The execution layer handles tool invocation, permission validation, and MCP protocol.

---

## Local Tools (directory-based)

```
skills/
  email-parser/
    tool.json      # manifest
    handler.ts      # implementation
    handler.test.ts # tests
```

### Tool Manifest (`tool.json`)

```json
{
  "name": "email-send",
  "description": "Send an email via the Nylas API",
  "version": "1.0.0",
  "sensitivity": "elevated",
  "action_risk": "medium",
  "inputs": { "to": "string (contact ID or \"principal\")", "subject": "string", "body": "string", "cc": "string? (contact IDs or \"principal\")" },
  "outputs": { "messageId": "string", "threadId": "string" },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

- `sensitivity`: `"normal"` or `"elevated"`. **`elevated` means the skill requires a *live principal turn*** — the current turn must have originated from a fresh principal inbound. The signal is a **distinct `liveTurn` field** on the `agent.task` payload (not a metadata-bag key, so it can never be swept into a persisted/wakeable row): the dispatcher stamps it on principal inbounds, and the `delegate` skill forwards it across a **synchronous** delegation, so "the CEO is live" spans the whole synchronous call tree — a delegated specialist acting inside the CEO's turn qualifies, but a wake, scheduler fire, or persisted task never does. It is the live-principal authority primitive: only the CEO, acting now (directly or through a synchronous delegate), may invoke it. System, agent, and woken/inherited principal-*lineage* contexts all fail, with zero per-skill exceptions — this closes the self-approval hole (a woken principal-lineage task cannot approve its own pending action). Enforced **solely** at the execution-layer gate (`isLivePrincipalTurn`); elevated skills carry no handler-level origination re-check (#1126). The elevated set is the CEO-authority primitives: the approval-queue + autonomy controls, the grant-recommendation decisions, the authorization-altering contact skills (`contact-set-tier`/`contact-set-role`/`contact-grant-permission`/`contact-revoke-permission`), and `system-secret-capture-request`. Consequential *mutations* that are not authority primitives are `normal` + `action_risk` instead, governed by the autonomy engine and inheriting the ADR-018 approval flow. See ADR-017.
- `action_risk`: required on all manifests. Named labels — `none`, `low`, `medium`, `high`, `critical` — map to minimum autonomy score thresholds. Raw integers (0–100) are also accepted for precision. Enforced by the execution layer against the live autonomy score.
- `secrets`: declares which vault secret keys the skill will request via `ctx.secret()` (vault-first, env fallback at bootstrap)
- `permissions`: declared capabilities, validated at load time
- `timeout`: per-invocation timeout in ms; exceeded invocations return a failure result (default 30000)
- `install.requires_secrets` (optional): vault secret keys that must already exist before the skill can be **installed or enabled** in the registry. `RegistryService` rejects install/enable until every listed key is present in the vault. This is the install/enable gate, distinct from the runtime `secrets` allowlist above. Example: `web-search` declares `"install": { "requires_secrets": ["tavily_api_key"] }`. (An `uninstall` block is parsed but currently inert.)
- `skip_secret_redaction` (optional, boolean): opts the skill's output out of **only** the broad generic-long-hex secret scrub in output sanitization — the structured credential patterns (API keys, JWT/Bearer, AWS) still apply, as do tag-stripping and truncation. Gated at startup to skills that declare the `secretCapture` capability. Exists so a skill whose output legitimately carries a high-entropy capability token (e.g. the secret-capture one-time link) can relay it to the LLM intact. Default false.
- `provenance_source` (optional, boolean): the skill's successful output is source text for identifier provenance. The runtime indexes the identifiers in it under the task's root conversation, and contact skills verify an agent-entered address only when a person's message or such a result contains it, or the principal approved the write (#2061, ADR-047). Only for skills whose output is data they read, never model-written text. Default false.
- `optional_capabilities` (optional): capability names the skill uses when the deployment has them and can do without (#2024). A missing required capability refuses the call; a missing optional one is simply not injected, so the handler checks for it. A name may not appear in both lists. `skill-activate` declares `taskRepo` here.

**Privilege access** — skills declare which privileged services they need via `"capabilities": [...]` in `tool.json`. The loader validates names against a fixed allowlist (`VALID_CAPABILITIES` in `src/skills/loader.ts`) at startup and rejects unknown names. The manifest is frozen after loading. The execution layer injects only declared services into `ToolContext` — skills cannot self-escalate at runtime. Universal services (`contactService`, `entityContextAssembler`, `agentPersona`) are available to all skills without declaration. Three secret-related capabilities: `secretCapture` (grants `ctx.secretCapture` to mint one-time vault capture links), `secretResolver` (grants `ctx.resolveSecretRef` to resolve a `user.*` secret by reference at runtime — additionally hard-allowlisted to `web-browser` in the execution layer), and `userSecretIndex` (grants `ctx.listUserSecretNames` to list `user.*` key names only — hard-allowlisted to `list-user-secrets`; never values, never system/channel keys). See the `capabilities` section in `docs/dev/adding-a-tool.md` for the full capability reference.

**Caller restrictions** — skills can declare `"allowed_callers": ["agent-name", ...]` in `tool.json` to restrict which agents may invoke them. The execution layer checks the calling agent's name against this list after the elevated-skill gate but before score-based autonomy gates — this avoids creating pointless approval requests for structurally forbidden callers. If the caller is not in the list, the invocation is rejected with a structured failure. The special value `"system"` matches system-layer invocations (checkpoint processor, etc.). CEO-approved re-executions (`humanApproved: true`) bypass the caller gate. Names in `allowed_callers` are validated against known agent names at startup — unknown names cause a hard startup failure.

### Skill Handler Interface

```typescript
interface ToolHandler {
  execute(ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  input: Record<string, unknown>;  // validated against manifest inputs
  secret(name: string): string;    // scoped secret access (resolves a vault secret key)
  log: Logger;                     // scoped pino child logger
  agentPersona?: AgentPersona;     // display name, title, email signature — available to all skills
  caller?: CallerContext;          // caller identity (audit/context; not the elevated-gate signal — see sensitivity)
  contactService?: ContactService; // read-only contact lookups — available to all skills
  infraLlm?: InfraLlm;            // constrained LLM access (classify/extract only, no raw chat)
  secretCapture?: SecretCaptureMinter;            // capability-gated by `secretCapture` — mints one-time vault capture links
  resolveSecretRef?(ref: string): Promise<string>; // capability-gated by `secretResolver` — resolves a `user.*` secret server-side; value never enters LLM context; hard-allowlisted to web-browser
  listUserSecretNames?: () => Promise<string[]>; // capability-gated by `userSecretIndex` — `user.*` key names only; hard-allowlisted to list-user-secrets
  appOrigin?: string;            // available to all skills — public origin used to build capture-link URLs
  httpPort?: number;             // available to all skills — local HTTP port, dev fallback origin for capture-link URLs
  signal?: AbortSignal;          // every invocation — aborted at the manifest timeout; pass to network calls (#2083)
  deadline?: number;             // every invocation — epoch ms of the timeout; with `signal`, satisfies CallBudget (#2083)
  resolveRecipientReference?: (channel, value, fields) => Promise<RecipientResolution>; // contact reference → verified address, for draft-only tools without outboundGateway; fails closed (#2053, ADR-047)
  selfEmails?: readonly string[]; // every mailbox Curia owns — email-reply drops them from reply-all CC (#1815)
  // ...plus service-specific fields injected per-skill by name (bus, entityMemory, etc.)
}

type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };
```

Skills cannot self-grant privileges — all service access (bus, entityMemory, calendar client, etc.) must come from the injected `ToolContext` via explicit per-skill grants in the execution layer. Skills are invoked synchronously within the agent turn via `ExecutionLayer.invoke()`. Skills are sandboxed to their declared I/O and must never throw — all error paths return `{ success: false, error: '...' }`.

---

## MCP Skills (external servers)

The framework acts as an MCP client connecting to external MCP servers:

```yaml
# config/skills.yaml
mcp_servers:
  - name: google-workspace
    transport: sse
    url: https://mcp-server.example.com/mcp
    headers:
      Authorization: "Bearer <token>"
    action_risk: low
    permissions: ["workspace:read", "workspace:write"]
    secrets:                             # optional — declares vault keys this server needs
      - key: google_oauth_client_id      # vault key name
        label: "Google OAuth Client ID"
        masked: false
      - key: google_oauth_client_secret
        label: "Google OAuth Client Secret"
        masked: true
```

Supported transports: `stdio` (local subprocess) and `sse` (a hosted endpoint). Despite its name, `sse` connects with StreamableHTTP — the current MCP SDK recommended transport; the deprecated SSE client is no longer used.

**MCP credential management.** MCP servers may declare required secrets via a `secrets:` block (`McpSecretDeclaration[]` — `key`, `label`, `masked`). The web console's **Settings → MCP Skills** page presents credential fields for each declaration, writes values to the encrypted vault, and gates enable/disable on whether all required secrets resolve. This mirrors the Channels registry pattern. Internally, `McpRegistryService` (`mcp_server_registry` table, `reconcileMcpRegistry` bootstrap step) tracks install/enable state for each MCP server. `loadMcpServers` filters to enabled servers only.

At startup, the framework connects to each MCP server, discovers tools via `tools/list`, and registers them in the skill registry alongside local skills. Agents don't know or care whether a tool is local or MCP.

---

## Skill Discovery & Activation

Vocabulary (ADR-031): a **tool** is the callable atom; a **skill** is a bundle of tools +
optional `SKILL.md` instructions. Agents pin **skills** (`pinned_skills`); discovery and
activation also operate at the skill level.

Two orthogonal axes (design §6 / #1495):

| Axis | Options |
|------|---------|
| **Availability** | pinned (curated, always in toolkit) vs discoverable (`allow_discovery`) |
| **Instruction-loading** | eager (bootstrap) vs lazy (on activation). Pinned ≠ eager for future imports; today pinned skills load instructions at bootstrap. |

### Tiered lookup

1. **Tier 0 — pinned skills** — expanded at bootstrap via `resolvePinnedSkills` (member tools + instruction blocks). Unchanged by activation.
2. **Tier 1 — task-active skills** — recorded in `tasks.progress.activeSkills`. On each wake, re-loaded as a strong prior: skills with no whole-token overlap (≥3 chars) against the current step are dropped when any other active skill still matches; if none match, MRU fills up to the cap (default 5). Unchanged sets are not re-written (no `updated_at` / bus churn).
3. **Tier 2 — discovery** — only when Tiers 0/1 miss and the agent has `allow_discovery: true`.

### Pinned skills (Tier 0)
Explicitly listed in agent config (`pinned_skills`). Always available to the agent, always included in the LLM's tool list; instruction bodies are appended to the system prompt at bootstrap.

### Discoverable tools & skills (Tier 2)
All registered tools and non-synthetic skills are searchable via the built-in `tool-registry` tool. Agents with `allow_discovery: true` automatically receive `tool-registry` and `skill-activate` in their tool list. When the LLM needs a capability not in its pinned set:

```text
tool-registry({ query: "send email" })
```

Returns matches with `kind: "tool"` (orphan / synthetic-owned atom) or `kind: "skill"` (bundle).
Member tools of a real skill are **promoted to the owning skill** — discovering `task-create`
returns the `tasks` skill, not the atom alone — so the discipline block cannot be skipped.

**Tools** (`kind: "tool"`) are immediately callable: after `tool-registry` succeeds,
`AgentRuntime` appends their schemas to the per-task working tool list.

**Skills** (`kind: "skill"`) require activation:

```text
skill-activate({ skill: "tasks" })
```

Activation loads member tools into the working toolkit and injects the skill's `SKILL.md`
body into the turn. It **never widens authority** — member tools still pass `allowed_callers`
and `action_risk` at invoke time; disallowed members are listed in `skippedTools` and omitted.

### Imported Anthropic skills (Phase 3 / #1490)

An unmodified Anthropic Agent Skill folder (`SKILL.md` + optional `references/` / `assets/` /
`scripts/`) loads as a skill bundle with **no Curia `tool.json` required**. Operator flow:
drop the folder into the skills directory, install+enable in the registry, restart. See
[`docs/dev/importing-a-skill.md`](../dev/importing-a-skill.md).

- **Progressive disclosure:** activation returns the `references` / `assets` index; call
  `skill-activate({ skill, reference: "…" })` to load one text file into the turn (path-traversal
  safe; binary assets are rejected).
- **Scripts:** if `scripts/` is present, startup emits a warning and leaves scripts **inert**
  (sandbox execution is Phase 4).
- **Authority:** an imported skill cannot grant tools the activating agent was not already
  allowed to call — instructions only steer.

When a task is bound, activation also appends the skill to `progress.activeSkills` (MRU,
capped) so park/resume wakes restore Tier 1.

Tool-list expansion is **per-task**: each task gets a local copy of the startup tool list.
`tool-registry` and `skill-activate` are excluded from search results to avoid circular
self-discovery.

### Safety Gate for First-Time Use

- Skills tagged `sensitivity: "normal"`: auto-approvable; governed by the autonomy engine via `action_risk` (and `allowed_callers` where set)
- Skills tagged `sensitivity: "elevated"` (CEO-authority primitives — approve/deny/dismiss actions, set-autonomy, grant-recommendation decisions): require a **live principal turn**, enforced at the execution-layer gate (`isLivePrincipalTurn`). Not a per-agent first-use approval — every invocation must be a fresh principal turn (#1126)
- The deferred per-agent-skill `skill_approvals` "ask once on first use by that agent" flow is a separate, still-unbuilt concern (persist-once-ask-once); it would layer on top of, not replace, the elevation gate
- Elevation rejections and autonomy-gate blocks are audit-logged
- **Activation ≠ authorization** — activating a skill only surfaces + instructs; it cannot grant a tool the agent was not already allowed to call

---

## Tool, Skill & Agent Registry

Tools, skills, and agents are not enabled merely by existing on disk — they are tracked in registry tables with an explicit install/enable lifecycle. There are now **three** tables, all the same column shape (`name` PK, `enabled`, `installed_at`, `installed_by`, `enabled_at`, `enabled_by`, `updated_at`):

- **`tool_registry`** — the invocation atoms. Renamed from the original `skill_registry` in migration `075_rename_skill_registry_to_tool_registry.sql` as part of the tools/skills rework (#1485).
- **`skill_registry`** — the collection/bundle layer (calendar, task-management, imported Anthropic skills). Created fresh in migration `076_create_skill_registry.sql` (#1489); bundle rows are cross-referenced against on-disk `SKILL.md` discovery.
- **`agent_registry`** — agents.

- **Disabled by default.** A newly added tool, skill, or agent is registered at startup but starts **disabled** — except core defaults from `config/registry-defaults.yaml` and member tools of an enabled bundle.
- **Bundle expansion (#1974).** An enabled bundle owns its members: listing a tool in its SKILL.md `tools:` enrolls the tool (enabled) on the next boot, so `registry-defaults.yaml` `tools:` lists standalone tools only. A member gated by `install.requires_secrets` (or a capability whose integration this boot did not build) gets no row until the first boot after its gate clears. Uninstalling a member is refused while its bundle is enabled, since the next boot would re-enroll it; disable it instead. A disabled bundle is never expanded. See the [ADR-022](../adr/022-skill-agent-registry.md) amendment.
- **Restart-based enforcement.** Enabled items are loaded/registered at startup; disabled items are skipped. Changing enable state takes effect on the next restart — there is no live reload.
- **Secret gating.** `RegistryService` enforces `install.requires_secrets`: install/enable is rejected until every declared vault secret key exists in the vault. `web-search` is the first consumer (`requires_secrets: ["tavily_api_key"]`).

Lifecycle is driven via the registry HTTP routes (`src/channels/http/routes/registry.ts`), where `:kind` ∈ `{tools, skills, agents}`:

```text
GET    /api/registry/tools
GET    /api/registry/skills
GET    /api/registry/agents
POST   /api/registry/:kind/:name/install
POST   /api/registry/:kind/:name/enable
POST   /api/registry/:kind/:name/install-enable
POST   /api/registry/:kind/:name/disable
DELETE /api/registry/:kind/:name
```

### Managing bundles from the console (#1724)

`/tools` renders tools, skills, and agents as one parent/child model: a bundle row with its
member tools nested underneath, and any orphan (synthetic-owned) tool as a top-level row. A
member declared in a manifest but absent from `tool_registry` discovery is rendered as
*uninstalled* rather than silently dropped.

- **Cascade.** Enabling or disabling a bundle from the UI goes through `BundleCascadeRepo`,
  which writes `skill_registry` and `tool_registry` in a **single transaction**. A
  half-applied cascade — bundle enabled, some members off — is worse than either end state,
  because it is exactly the partial configuration the parent/child view exists to make
  impossible. Any failure rolls back. The HTTP routes above are unchanged; the cascade is a
  repo concern.
- **Unresolved pins.** Bundle membership and pin consumers (`pinnedBy`) are propagated into
  the registry API payload — they were previously dropped during discovery mapping. A bundle
  that is **not enabled** but is pinned by an **enabled** agent is flagged in the UI as
  unresolved for that agent. This is a real production failure mode and it is silent without
  the flag: an un-enrolled bundle takes its whole tool set out of the pinning agent's hands,
  and the only other signal is a startup warning (`unresolvedPins`, reasons `not_found` or
  `member_tools_missing`).

Channels have their own parallel registry — see [spec 04 — Channels](04-channels.md).

---

## Execution Layer

Skills are invoked directly by `AgentRuntime` via `ExecutionLayer.invoke(toolName, input, caller, options)`. The execution layer is constructed once per process and shared across all agents.

Invocation flow:

1. **Resolve** — look up skill in registry by name (local or MCP)
2. **Normalize inputs** — convert timestamp inputs to UTC-offset ISO strings using the configured local timezone, then replace every tracked sign-in code in the input with `[sign-in code]` for every tool except `web-browser` (see *Sign-in code scrub* below)
3. **Validate elevation** — if `sensitivity: elevated`, reject unless this is a **live principal turn** (`isLivePrincipalTurn`: the distinct `options.liveTurn` flag — forwarded from `agent.task.payload.liveTurn` — plus principal lineage on the effective metadata). System, agent, scheduled, and woken/inherited principal-lineage contexts all fail — a wake is never a live turn; a synchronous delegation inside a live turn is (#1126). This is the sole enforcement point; no handler re-check duplicates it. (Distinct from the autonomy principal-bypass, which uses *lineage* via the ladder — see [14-autonomy-engine.md](14-autonomy-engine.md#effective-standing--the-bypass-ladder-wokenderived-tasks).)
4. **Validate caller** — if `allowed_callers` is set on the manifest, reject unless the calling agent is in the list (CEO-approved re-executions bypass this gate)
5. **Build context** — assemble `ToolContext` with scoped secrets, logger, and per-skill service grants
6. **Execute** — call `handler.execute(ctx)` with a timeout wrapper (local), or `tools/call` (MCP)
7. **Sanitize output** — strip injection vectors, redact secrets, truncate, wrap errors
8. **Return `ToolResult`** to the agent runtime for inclusion in the LLM's next turn

### Output Sanitization

*Lesson from Zora: tool outputs can contain injection vectors when fed back to the LLM.*

All skill results are sanitized before being included in the agent's LLM context:
- Strip any XML/HTML tags that could be interpreted as system instructions
- Truncate excessively long outputs (default: 200,000 chars) with a `[truncated]` marker
- Redact patterns matching known secret formats (API keys, tokens) using a configurable regex list
- Error strings are wrapped in a structured format (`<tool_error>...</tool_error>`) to prevent them from being interpreted as instructions

**Value-aware secret redaction (v0.35.0).** Secrets injected into the browser by reference (`web-browser` `secret_ref`) are tracked per browser session and scrubbed — both the raw value and its URL- and HTML-encoded variants — from returned content, the page URL, and error messages, so a hostile page cannot reflect an injected credential back into the LLM. Screenshots are suppressed on any action that fills a secret (an image cannot be value-redacted). The manifest field `skip_secret_redaction` is a narrow opt-out of only the broad generic-hex scrub (see Skill Manifest above) — it does not affect value-aware redaction or the structured credential patterns.

### Sign-in code scrub (#2017)

A delegated sign-in can pass a one-time code through the system, and nothing it touches should remember it. While a sign-in verification is pending or recently closed, the in-memory `CodeTracker` (`src/verification/`) holds the code values of those verifications. `ExecutionLayer.invoke` replaces every tracked value with `[sign-in code]` in **every string of every tool input**, after timestamp normalization and before the elevation gate, approval payloads, audit rows or the handler see it. The rule is default-deny: it covers task and scheduled-job notes, documents, `report-to-principal`, `memory-store`, every send skill and MCP tools without listing them, and it works on a copy so the caller's object is untouched. Matching is on token boundaries, case-insensitive, and covers a code split by one space or dash. The one exemption is `web-browser`, which must receive the real value to type it and guards its own destinations (below). Values are never written to the `verifications` table, to logs or to error messages. See [ADR-050](../adr/050-external-verifications-as-first-class-state.md) and [spec 15](15-outbound-safety.md#sign-in-code-scrub-2017).

The tracker is in memory, so a process restart drops every tracked value (the browser sessions they belong to die with it). Values are registered from `web-browser` typing, the dispatcher (the principal's own new text while an `sms` or `app` verification is open) and the `delegate` skill (a ceo-inbox result while an `email` verification is open); they age out `verification.codeTtlMinutesAfterClose` minutes after the verification closes.

**`web-browser` and verifications.** With the verification runtime wired, `web-browser`:

- refuses to `type` or `select` a tracked code, or `navigate` to a URL containing one (raw, form-decoded or percent-decoded), on any page that is not on the registrable domain of a verification that tracked it, or in any browser session but that verification's. `login.aircanada.com` matches `aircanada.com`; a lookalike does not, and a page with no registrable domain (`about:blank`, an IP) never matches. The session keeps apart two verifications on one identity provider: exactly for a typed code (registered only against this session's verifications), best-effort for a relayed or inbox code, which cannot be attributed to one session. The refusal does not echo the value;
- while any code is tracked, refuses a `press_key` that may type a character, or a paste chord (Control/Meta/ControlOrMeta+V, Shift+Insert), unless the document holding keyboard focus (followed down through focused iframes, judged by its nearest website frame) is on the page domain of a pending or recent verification in this session; focus it cannot follow, or a failed lookup, refuses too. The classification fails closed: only an allowlist of non-printing named keys (Enter, Tab, Backspace, Delete, Escape, arrows, Home/End, PageUp/PageDown, Insert, F1–F24, lock keys, bare modifiers) and chords with a Control/Meta modifier other than paste always pass; every other key name (`4`, `Digit4`, `KeyA`, `Space`, `ShiftLeft+4`) is guarded. The guard covers a whole tracked value in one `type`, `select` or `navigate`, a single printable key and a paste chord; a code split across several `type` calls ("482", then "913") is a known residual, not recognised;
- tracks a code-shaped literal it types on the `page_domain` of a verification waiting in this session (the only source for a 4–5 character code the principal relays inside a longer message), and scrubs it from what the session reads back;
- adds `verification_suspected: { page_domain, signals[] }` to its page state when the page carries a one-time-code input, a short numeric input beside code-entry wording, or a delivery-choice screen. It is a nudge, not a decision;
- logs navigate URLs through a log-safe form, with a code replaced or the URL withheld.

### Resource Boundaries

*Lesson from Zora: unbounded operations exhaust memory and block the system.*

- **Timeout enforcement**: Every skill invocation has a timeout (from manifest or default 30s). Exceeded invocations are killed and return a failure result.
- **Concurrent invocations**: Max 5 concurrent skill invocations per agent task — not yet implemented
- **Buffer limits**: Streaming skill responses capped at 1MB — not yet implemented

#### Timeout safety: handlers must be at-most-once

Skill timeouts are enforced via `Promise.race` against the handler. On timeout, the layer aborts `ctx.signal`, but the in-flight handler is **not** stopped — any side effects it has already committed (DB writes, bus publishes, outbound sends) persist, and the caller sees a `<skill_error>Skill 'X' timed out after Yms</skill_error>` result.

This means a "timed out" result is **not the same as "no work happened"**. Callers cannot safely retry on timeout unless the skill is genuinely idempotent (e.g. accepts an idempotency key, or only reads).

Skill handlers should be designed so that a timeout leaves no half-committed visible state:

- If the skill's purpose is to **create a thing** (a thread, a draft, a message), persist that thing as the first awaited step, then make every downstream step fire-and-forget. `bullpen-post` follows this pattern: `openThread()` (synchronous, awaited) followed by `bus.publish(agent.discuss)` (fire-and-forget, with a `.catch` for logging) — agents see the new thread via pending-thread context injection even if the publish never fires.
- If the skill's purpose is to **deliver a side effect that cannot be made fire-and-forget** (a wire-level send), the timeout must be set comfortably above the channel's p99 latency, and callers must be instructed not to retry.
- Skills that internally `await` long-running infrastructure (e.g. an LLM call as part of `infraLlm`) must propagate timeouts so the skill's own timeout is the effective deadline.
- Pass `ctx.signal` to every network call so a timed-out request is cancelled, and check it before a write: a read-modify-write that finishes late can otherwise undo a newer call's write (#2083). `ctx.deadline` gives the remaining budget; `src/util/call-budget.ts` has helpers.

---

## Secrets Access

Skills access secrets via `ctx.secret("name")`:

- **Implementation:** An **encrypted application-layer vault** backs the accessor. Secrets are stored AES-256-GCM-encrypted in the `secrets` table (one row per secret: `name`, `value_format`, `encrypted_value`, `iv`, timestamps) and decrypted on read by `SecretsService` using `SECRET_ENCRYPTION_KEY`. See [ADR-020](../adr/020-secrets-vault.md) (app-layer AES-256-GCM vault) and [ADR-021](../adr/021-vault-only-secret-resolution.md) (vault-only resolution).
- **Resolution order:** vault-first. `SecretsService.get(name)` returns `Promise<string | null>` and reads only the vault — there is no env fallback inside the service. The vault-first-then-env fallback happens once at bootstrap via `applyVaultSecrets()`. The only secrets that remain in `.env` are the four bootstrap values needed to reach and unlock the vault: `DATABASE_URL`, `SECRET_ENCRYPTION_KEY`, `DB_USER`, `DB_PASSWORD`.
- `SecretsService.list()` returns `Promise<string[]>` — secret **names only**, never values.
- The execution layer validates that the calling skill's manifest declares the requested secret in its `secrets` array.
- Agents/LLMs never see secret values — only skills access them internally.
- All secret access is audit-logged (the `secret.accessed` event records which secret, when, and the resolution source `vault | env`) but values are never logged.
- **Seeding & rotation:** `pnpm run seed-vault` upserts secrets (transient-env usage, e.g. `NYLAS_API_KEY=nyk_... pnpm run seed-vault`); `scripts/rotate-secret-key.ts` re-encrypts every row under a new key in a single transaction. See [Configuration → Secrets](../dev/configuration.md#secrets).

---

## Built-in Skills

The framework ships with these skills (in `skills/` as part of core):

- `tool-registry` — search for available skills by keyword; injected into tool list for agents with `allow_discovery: true`
- `delegate` — route a sub-task to a specialist agent via the bus
- `web-fetch` — HTTP GET with configurable timeouts and size limits
- `web-browser` — Playwright-backed browser for JS-rendered pages. v0.35.0 added: secret-by-reference fill (`secret_ref` — a `user.*` secret name; the value is filled server-side and never shown to the LLM), incognito sessions (`incognito: true` — ephemeral, isolated context off the principal's persistent profile), opt-in ad-blocking (`block_ads: true`, off by default — keep off for auth/login/form-fill flows), new interaction actions (`scroll`, `hover`, `press_key`, `wait_for`), iframe awareness with per-frame SSRF gating (private/internal child frames are skipped), a persistent profile (shared cookies/storage across sessions), and fingerprint hardening (real Chrome channel + stealth, no stale UA override)
- `verification` — coordinator-only (`action_risk: low`): `open | satisfy | abandon | list` records for pending sign-in verifications in the `verifications` table (spec 19 and [ADR-050](../adr/050-external-verifications-as-first-class-state.md)). One pending row per site (a second `open` for the same errand reuses it; one for a different task abandons it and opens a fresh row, and says so); `open` takes the page domain from the browser session's own URL and returns the channel to ask the principal on (`verification.askChannelOrder`, default signal, sms, slack, email; the configured order alone decides, and the channel the errand arrived on plays no part). Never takes a code value. The coordinator and ceo-inbox see live records in a per-turn block, not in their always-on prompts
- `web-search` — web search via Tavily API
- `scheduler-create` / `scheduler-list` / `scheduler-cancel` — create and manage scheduled jobs
- `email-send` / `email-reply` — outbound email via Nylas (multi-account aware)
- `slack-send` — proactive outbound Slack DM/message with Gate C carve-out (#1526)
- `sms-send` — outbound SMS via the Telnyx office DID
- Calendar skills (`calendar-list-calendars`, `calendar-list-events`, `calendar-create-event`, etc.) — Nylas calendar CRUD
- Contact skills (`contact-create`, `contact-lookup`, `contact-merge`, etc.) — contact management and KG linking
- `config-store` — generic namespaced key-value store for persistent agent configuration; backs `company`, `meeting_links`, `travel_preferences`, `loyalty_programs`, `writing_config`, and any future per-agent config needs. It owns the principal's own standing settings (company, meeting links, travel preferences, loyalty programs); memory owns facts about people, organizations and things. Config values are permanent and looked up by exact key, whereas memory facts can decay and a `memory-query` search finds a config value only through an embedding of its bare key label. Keeping everything in memory, or merging the two tools, was rejected for those reasons (#1954).
- `entity-context` — assemble full context for a list of contacts/entities
- `get-autonomy` / `set-autonomy` — read and write the global autonomy score (CEO only)
- `bullpen` bundle — inter-agent discussion threads, one tool per action so each schema marks its own fields required (#2126): `bullpen-post`, `bullpen-reply` (optionally `close_after`), `bullpen-read`, `bullpen-close`. Post and reply persist the thread/message synchronously and fire-and-forget the `agent.discuss` publish so a slow subscriber can't push the handler past its timeout (see *Timeout safety* above)
- `image-generate` — generate an image from a text prompt via DALL-E 3; returns a temporary CDN URL (~1hr TTL)
- `setup-status` — read-only (`action_risk: none`); returns the setup catalog (`skills/setup/tools/setup-status/catalog.yaml`) with each task's live-derived status (`done` / `pending` / `deferred`). The catalog is owned by the skill bundle, not core.
- `setup-defer` — write (`action_risk: low`); persists or clears a setup task deferral in config-store (`setup_wizard/deferrals`). Pinned to `setup-wizard`.
- `context-bridge-clear` — write (`action_risk: low`); bulk-releases active outbound-context entries matching a list of meeting subjects across the full active window (not just the injected slice). Pinned to coordinator, contacts, ceo-inbox, and meeting-debrief.

> **Removed from scope:** `file-reader` and `file-writer` were originally planned but removed after security review. General-purpose filesystem access from LLM-driven agents on a single-tenant VPS creates an unacceptable prompt-injection-to-file-exfiltration attack vector. Email attachments (the primary use case) are handled in-memory via the Nylas SDK's streaming/buffer APIs. Agent-created documents should use the knowledge graph. If a narrowly-scoped filesystem need arises later, build a purpose-specific skill rather than a general reader/writer.

---

## Recommended MCP Servers

Apart from Google Workspace, these are not bundled but documented as recommended integrations:

| Server | Purpose | Link |
|---|---|---|
| **Google Workspace** | Drive, Docs, Sheets only (#1957). **Shipped** in `config/skills.yaml` (stdio), version pinned in the image via `scripts/workspace-mcp.pin` (#2010); agents load it on demand with `skill-activate` (#2024) | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) |
| **Filesystem** | Scoped file access (read/write/search) | [modelcontextprotocol/servers/filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| **GitHub** | Repo management, issues, PRs | [modelcontextprotocol/servers/github](https://github.com/modelcontextprotocol/servers/tree/main/src/github) |
| **Brave Search** | Web search for research agents | [modelcontextprotocol/servers/brave-search](https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search) |
| **Fetch** | Web fetching with robots.txt compliance | [modelcontextprotocol/servers/fetch](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) |

---

## Known Deficiencies

- **`skill_approvals` persist-once-ask-once flow** — the per-agent-skill "ask once on first use by that agent" safety gate is still unbuilt (deferred), separate from the live-principal elevation gate.
- **Max-5 concurrent invocations limit** — the per-agent-task cap on concurrent skill invocations is not yet implemented.
- **1MB streaming buffer cap** — the buffer limit on streaming skill responses is not yet implemented.

# Robust Specialist Delegation

**Date:** 2026-04-28
**Status:** Proposed
**Scope:** Config, runtime injection, agent YAML, coordinator prompt

## Problem

When the CEO asks Curia to polish an essay, the essay-editor specialist agent
fails repeatedly due to three compounding issues:

1. **Google account hallucination.** The Google Workspace MCP tools require a
   `user_google_email` parameter on every call. No system-level infrastructure
   tells agents which accounts exist. The LLM guesses, and guesses wrong
   (observed hallucinations: `joseph@kuhuai.co.nz`, `joseph@josephkrauss.com`).
   Only when the coordinator explicitly stated "use nathancuria1@gmail.com" did
   the MCP tools succeed.

2. **Delegate timeout too short.** The delegate skill defaults to 90 seconds.
   The essay-editor pipeline (read docs, verify citations, create folders, copy
   files, generate cover art, then edit the full essay) exceeds this easily.
   After the tool-call steps complete, the LLM enters a long pure-text
   generation for the actual essay edit. The delegate times out, the coordinator
   retries from scratch, and the cycle repeats.

3. **No expectation-setting on synchronous channels.** When the CEO sends the
   request via chat, the coordinator says "delegating" and then goes silent for
   90 seconds before timing out. No acknowledgment that this is a long-running
   task. Via email (async) this is acceptable, but on synchronous channels
   (chat, CLI, Signal) the CEO is left watching a dead screen.

## Evidence

Six essay-editor delegations on 2026-04-27, all for the Private Credit essay.
Full audit trail in `audit_log` table, `source_id = 'essay-editor'`.

- Runs 1-3: LLM used wrong Google email or bypassed MCP tools entirely.
  All Google Doc reads failed with AUTH errors.
- Run 4-5: Coordinator told essay-editor "use nathancuria1@gmail.com". MCP
  tools worked. Read all docs, verified citations, created Drive folder,
  copied v1, generated cover art via DALL-E. Then the delegate timed out
  during the essay-editing generation step (pure LLM, no tool calls).
- Run 6: Coordinator retried without explicit email. LLM hallucinated
  `joseph@josephkrauss.com`. AUTH failure again.

## Design

### 1. Google Workspace Account Awareness

Extend the existing `channel_accounts` pattern (proven for email) to cover
Google Workspace.

**Config (`config/default.yaml`):**

```yaml
channel_accounts:
  email:
    curia: { ... }   # existing
    joseph: { ... }   # existing
  google_workspace:
    curia:
      google_email: "env:PRIMARY_GOOGLE_EMAIL"
      primary: true
    joseph:
      google_email: "env:SECONDARY_GOOGLE_EMAIL"
```

Environment variable names must be generic and role-based. Never use
deployment-specific names (no "Nathan", "Joseph", etc.) in env vars. The
logical account names (`curia`, `joseph`) live in YAML only and map to
generic env vars.

**Runtime injection (`src/agents/runtime.ts`):**

The runtime already builds a "Your Contact Details" block for the coordinator
from resolved `channelAccounts`. Two changes:

1. Include `google_workspace` accounts in that block, marking which is primary.
2. Inject this block into **all agents**, not just the coordinator. Specialists
   like essay-editor need it too.

The injected section in the system prompt:

```
## Your Google Workspace Accounts
- curia: nathancuria1@gmail.com (primary)
- joseph: joseph@josephfung.ca
```

(Actual values resolved from env vars at boot.)

**Prompt guidance (applied to coordinator and Google Workspace specialists):**

> When calling Google Drive or Google Docs tools that require
> `user_google_email`, use your primary Google Workspace account. If the tool
> returns an authentication error, retry with the next available account before
> reporting failure.

**Files changed:**

- `config/default.yaml` -- add `google_workspace` section under
  `channel_accounts`
- `src/config.ts` -- extend `resolveChannelAccounts()` to handle the new
  section (same env-var resolution pattern as email)
- `src/agents/runtime.ts` -- extend the contact details injection to include
  Google Workspace accounts; apply to all agents, not just coordinator
- `src/index.ts` -- pass resolved Google Workspace accounts through to the
  runtime
- `.env` / `.env.example` -- add `PRIMARY_GOOGLE_EMAIL`,
  `SECONDARY_GOOGLE_EMAIL`
- Agent YAMLs -- no changes needed; the runtime injects account info
  automatically

### 2. Per-Agent Delegation Timeout

Add an optional `expected_duration_seconds` field to the agent config schema.

**Agent YAML (`essay-editor.yaml`):**

```yaml
expected_duration_seconds: 600  # 10 minutes
```

**Runtime wiring (`src/agents/runtime.ts`):**

When the runtime detects a `delegate` skill invocation, it looks up the target
agent's config from the agent registry. If the delegate call does not already
include a `timeout_ms` parameter, inject one based on the target agent's
`expected_duration_seconds`.

This mirrors the existing path for scheduled tasks, which already injects
`timeout_ms` from `expectedDurationSeconds` on the job.

**Fallback behavior:**

- Target agent declares `expected_duration_seconds`: use it
  (`expected_duration_seconds * 1000` as `timeout_ms`)
- Target agent does not declare it: fall back to
  `DEFAULT_SPECIALIST_TIMEOUT_MS` (90s), same as today
- Caller explicitly passes `timeout_ms`: caller wins (existing behavior
  preserved)

**Files changed:**

- Agent YAML schema (and the Ajv startup validator) -- add optional
  `expected_duration_seconds` field
- `src/agents/runtime.ts` -- when invoking the `delegate` skill, look up
  target agent config and inject `timeout_ms` if not already provided
- `repos/curia-deploy/custom/agents/essay-editor.yaml` -- add
  `expected_duration_seconds: 600`
- No changes to `skills/delegate/handler.ts` -- it already accepts and
  respects `timeout_ms`

### 3. Expectation-Setting on Synchronous Channels

Prompt-only change to the coordinator. No code changes.

**Coordinator prompt guidance (`agents/coordinator.yaml`):**

> When delegating a task that will take significant time (essay polishing,
> research, multi-step workflows) and the message arrived via a synchronous
> channel (cli, http, signal), send a brief acknowledgment first in your own
> words. Communicate the intent: "This will take some time and I'll reply when
> I'm done." For email, delegate silently without acknowledgment.

**What this means mechanically:**

The coordinator generates a text response (the ack) before calling the
delegate tool. The LLM loop publishes this as `agent.response` /
`outbound.message`, which reaches the user immediately via SSE or CLI. Then on
the next turn, the coordinator calls the delegate skill. When the specialist
finishes, the coordinator sends a second response with the result.

This works today with no infrastructure changes. The coordinator can already
emit multiple responses across turns within a single conversation.

**Files changed:**

- `agents/coordinator.yaml` (or the curia-deploy override) -- add delegation
  acknowledgment guidance to the system prompt

## Out of Scope

- Real-time progress streaming (showing individual pipeline steps as they
  happen). Valuable future work but not needed now.
- MCP-layer auto-injection of `user_google_email` (removing the parameter from
  LLM control entirely). More rigid than needed; the prompt-based approach
  solves the hallucination problem while preserving multi-account flexibility.
- Background task architecture (delegate returns immediately, specialist
  delivers result as a separate message later). Would be a larger refactor;
  the timeout + ack approach solves the immediate UX problem.

## Testing

- Unit tests for `resolveChannelAccounts()` with `google_workspace` section
  (extend existing `config.channel-accounts.test.ts`)
- Unit test for runtime injection: verify Google Workspace accounts appear in
  system prompt for both coordinator and specialist agents
- Unit test for timeout injection: verify delegate calls to agents with
  `expected_duration_seconds` get the correct `timeout_ms`
- Integration/smoke test: delegate to essay-editor, confirm it uses the
  primary Google account without explicit instruction
- Manual verification: send essay polish request via chat, confirm
  acknowledgment appears before delegation begins

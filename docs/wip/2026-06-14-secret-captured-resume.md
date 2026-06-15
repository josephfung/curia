# secret.captured event + agent resume after secret capture (#972)

Follow-up to #971. Today secret capture is fire-and-forget: an agent mints a link, the
user fills it, and nothing tells the agent. This adds a `secret.captured` event and a thin
**resume** path that re-enters the originating agent when a capture arrives, so it can
continue what it was blocked on.

The secret **value** never flows through the LLM, the event, or the resume task — only
secret names/labels and routing metadata do. The agent reads actual values via
`ctx.secret()` / `ctx.resolveSecretRef()` only when it performs the action (#973).

## Design

No group/coordination layer. Each capture link is independent. When a capture arrives the
agent is re-entered and reasons about completeness from its own conversation history — it
asked for "username and password," now sees "username captured," so it knows it still waits
on the password. No DB bookkeeping duplicates that; the LLM already has the context.

State is parked on the token row; the agent is re-entered by publishing a synthetic
`agent.task` (mirrors the scheduler), not by holding a live process.

## Changes

### 1. Migration `054_add_secret_capture_routing.sql`
Add nullable routing columns to `secret_capture_tokens` (no new table):
`conversation_id TEXT`, `channel_id TEXT`, `agent_id TEXT`, `task_event_id TEXT`,
`originator JSONB`, `resume_intent TEXT`. All nullable → backward compatible with #971 rows.

### 2. Mint persists routing context (`secret-capture-service.ts`)
`MintNameArgs` gains an optional `origin` object (conversationId, channelId, agentId,
taskEventId, originator, resumeIntent). `mint()` writes these columns. The
`secret-capture-request` skill builds `origin` from `SkillContext`
(`conversationId`, `agentId`, `channelId`, `taskEventId`, `taskMetadata.originator`) and a
`resume_intent` derived from the optional skill input (defaults to the label).

### 3. `redeem()` returns routing context
`redeem()` returns a discriminated `RedeemOutcome`:
`{ status: 'ok'; captured: CapturedContext } | { status: 'expired' | 'not_found' | 'invalid_json' }`.
The atomic claim's `RETURNING` is widened to include the routing columns. Still idempotent
on `consumed_at` → one capture yields exactly one `captured`, a replay yields `expired` with
no captured context (so no event).

### 4. `secret.captured` event (`bus/events.ts`, `bus/permissions.ts`)
New `SecretCapturedEvent` (`sourceLayer: 'system'`) + `createSecretCaptured()` factory.
Payload: `{ secretName, label, conversationId?, agentId?, channelId?, taskEventId?,
resumeIntent?, originator? }` — **never the value**. Add `secret.captured` to the system
layer's publish and subscribe allowlists.

### 5. Publish on redeem (`routes/secret-capture.ts`, `http-adapter.ts`)
The capture POST route gets a `bus` and, on `status === 'ok'`, publishes `secret.captured`
(layer `'system'`) carrying only the captured routing context. `http-adapter` passes `bus`.

### 6. Resume subscriber (`src/secrets/secret-capture-resume-subscriber.ts`)
Subscribes to `secret.captured`. Per event it does one thing: re-enter the originating agent
by publishing a synthetic `agent.task` to the event's `agentId`/`conversationId`/`channelId`
with `parentEventId = taskEventId`, `originator` preserved, `senderId = originator.contactId`,
and content stating what arrived + the `resumeIntent`. In-memory dedup by event id so a
duplicate delivery never double-dispatches. If essential routing (agentId/conversationId/
channelId) is absent (e.g. a pre-migration token), it logs and skips — no dispatch.

### 7. Wire subscriber at startup (`index.ts`)
Instantiate the subscriber with `bus` + `logger` and `start()` it alongside the bus/scheduler.

## Tests (TDD)
- **Event/redeem:** `redeem()` returns captured routing on ok; a replayed (consumed) redeem
  returns `expired` with no captured context. Captured context carries no value.
- **Mint:** routing context is persisted on the token from the origin args.
- **Resume subscriber:** a `secret.captured` event injects an `agent.task` to the originating
  agent/conversation with `parentEventId` threaded and `resumeIntent` in the content;
  duplicate delivery does not double-dispatch; missing routing → no dispatch.
- **Privacy:** no secret value appears in any published event or injected task payload.

## Out of scope
Capture groups / multi-secret coordination; the consumer skill (#973, merged); bespoke
expiry sweeps (owned by #971's token lifecycle).

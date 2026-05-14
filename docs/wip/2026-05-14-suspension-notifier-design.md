# SuspensionNotifier Design

**Issue:** #538
**Date:** 2026-05-14
**Status:** Approved

## Problem

When a scheduled job hits 3 consecutive failures the scheduler suspends it and publishes a
`schedule.suspended` bus event. The existing response — creating a synthetic `agent.task` for
the coordinator — fails silently in the exact scenario that matters most: when the LLM API is
down. The coordinator needs the LLM to run, so if Anthropic is the thing that's broken, the
notification never reaches the CEO.

The real-world incident: on 2026-05-12 the `ceo-inbox` agent was suspended at ~09:15 due to
exhausted Anthropic API credits. It wasn't discovered until hours later.

## Solution

A dedicated `SuspensionNotifier` class that:

1. Subscribes to `schedule.suspended` on the event bus (`system` layer)
2. Sends a notification email via the existing `outbound.notification` pipeline — no LLM, no
   autonomy gate, no content filter in the critical path
3. Is registered at startup alongside other bus subscribers; disabled with a warning if
   `outboundGateway` or `ceoEmail` is absent

## Architecture

### Components

**`src/bus/events.ts`** (1-line change)
Add `'schedule_suspended'` to `OutboundNotificationPayload.notificationType`. This discriminant
identifies the email as a scheduler alert so future subscribers can route or filter it separately.

**`src/scheduler/suspension-notifier.ts`** (new file)
`SuspensionNotifier` class. Single responsibility: subscribe to `schedule.suspended`, format an
email, call `outboundGateway.sendNotification()`.

```
SuspensionNotifier
  constructor({ bus, outboundGateway, ceoEmail, logger })
  register()   → bus.subscribe('schedule.suspended', 'system', handler)
  handle(event) → outboundGateway.sendNotification(...)   [private, async]
```

**`src/index.ts`** (small addition)
After `outboundGateway` is constructed and before `scheduler.start()`, conditionally instantiate
and register `SuspensionNotifier`. If either `outboundGateway` or `config.ceoPrimaryEmail` is
absent, log a warning and skip — the scheduler continues normally.

**`tests/unit/scheduler/suspension-notifier.test.ts`** (new file)
Unit tests. See Testing section below.

### Data flow

```
Scheduler.handleCompletion()
  → completeJobRun() returns { suspended: true }
  → bus.publish('system', createScheduleSuspended(...))   ← already exists

EventBus delivers to registered subscribers:
  → AuditLogger.log()                                     ← already exists
  → SuspensionNotifier.handle()                           ← NEW

SuspensionNotifier.handle():
  → outboundGateway.sendNotification({
      notificationType: 'schedule_suspended',
      ceoEmail,
      subject,
      body,
    })
  → publishes outbound.notification to bus
  → EmailAdapter delivers via Nylas                       ← existing path
```

The notification path does not touch the LLM. The only dependency that can fail it is Nylas
(email send), which is independent of the Anthropic API.

### Notification format

**Subject:** `Scheduled job suspended: <agentId>`

**Body:**
```
Scheduled job suspended.

Agent:    <agentId>
Failures: <consecutiveFailures>
Error:    <lastError>

Job ID: <jobId>

To resume this job, open the web app and navigate to Scheduler → Jobs.
```

## Error handling

| Failure | Behaviour |
|---|---|
| `sendNotification()` throws | Caught in handler try/catch; logged at error. Non-fatal — suspension is already committed to DB and audit log. Scheduler is unaffected. |
| Email/Nylas stack is down | Same: caught and logged. The scheduler loop continues. |
| `outboundGateway` absent at startup | Notifier not instantiated; `logger.warn()` at startup. |
| `ceoEmail` absent at startup | Same as above. |

The event bus also catches subscriber errors independently (logs at error, swallows), but
`SuspensionNotifier` owns its own error boundary explicitly rather than relying on that.

## Testing

### Unit tests (`tests/unit/scheduler/suspension-notifier.test.ts`)

1. **Registers on the correct event and layer** — `bus.subscribe` called with
   `'schedule.suspended'` and `'system'`
2. **Sends notification on suspension** — trigger handler with a mock
   `ScheduleSuspendedEvent`; assert `sendNotification` called with `notificationType:
   'schedule_suspended'`, correct `ceoEmail`, subject containing `agentId`, body containing
   `agentId`, `lastError`, `jobId`, and `consecutiveFailures`
3. **Gateway failure is non-fatal** — `sendNotification` rejects; assert error is logged
   and handler promise resolves (does not rethrow)

### Integration coverage (extend `scheduler.test.ts`)

- `handleCompletion(false, error)` called 3× on the same job; `completeJobRun` returns
  `{ suspended: true }` on the third call
- Assert `bus.publish` was called with a `schedule.suspended` event containing correct payload
- Delivery to `sendNotification` is covered by the unit tests above; the integration test
  verifies only that the event fires correctly

## Acceptance criteria mapping

| AC | Covered by |
|---|---|
| `SuspensionNotifier` subscribes to `schedule.suspended` on the bus | Unit test 1; wiring in `index.ts` |
| Notification sent to CEO with agent ID, error, and resume instructions | Unit test 2 |
| Notification path does not invoke any LLM calls | Design — `sendNotification()` is Nylas-only |
| Notification delivery failure logged but does not block suspension flow | Unit test 3 (delivery failure); bus error isolation |
| Unit test: mock bus → verify gateway called | Unit test 2 |
| Integration test: 3 failures → verify notification event fires | Integration coverage above |

## Out of scope

- Deep-link URL in the notification body (SPA does not yet support deep linking)
- Filtering by agent ID (can be added later per the issue note)
- `schedule.recovered` notifications — not requested; would be a follow-on
- SQL resume instructions — replaced by web app guidance per review

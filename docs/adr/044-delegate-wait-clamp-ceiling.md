# ADR-044: Delegate wait clamp stays at 895 seconds

Date: 2026-09-25
Status: Accepted

## Context

The coordinator's wait for a specialist is `computeDelegateTimeoutMs` (a duration hint plus bounded headroom) or, when the specialist declares no hint, `delegate.defaultTimeoutMs`. Both are then clamped so the handler can emit a structured timeout before the delegate skill's outer execution timeout kills the invocation:

`DELEGATE_SKILL_OUTER_TIMEOUT_MS` (900_000) − `DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS` (5_000) = **895_000ms**.

#1857 measured 1,550 delegate runs from before the 2026-09-20 provider regression (the clean baseline #1873 later confirmed). Two of those runs exceeded 895s: `t2125-expense-tracker` at 1029s and `calendar` at 925s. That is 0.13% of the sample, both in the extreme tail.

#1799 already keeps the specialist running after the wait gives up and delivers the late result. In the window measured for #1857, every timed-out delegation that opened a pending row later resolved `delivered`.

The same issue raises the default wait from the deployment's 240s override to 450s (pooled p99 of 444s, rounded up) and adds per-agent hints where a specialist's own p99 sits above that floor. Those waits are all under 895s. The open question was whether the ceiling itself should move up to cover the two longer maxima.

## Decision

Leave the clamp at 895_000ms. A run that exceeds it is late-delivery-only by design.

Raising the ceiling means raising `DELEGATE_SKILL_OUTER_TIMEOUT_MS` and the matching `timeout` in `skills/delegate/tool.json`, which holds a coordinator turn parked for more than 15 minutes on a 1-in-750 event. Late delivery already returns that result. The false timeouts in #1857 were the 240s default, not the clamp: the two agents that already declared long hints (`t2125-expense-tracker` at 1800s, `essay-editor` at 3600s) both clamp to 895s and were covered at p99 (675s and 718s).

Rejected alternative: raise the outer skill timeout so the wait can follow the observed maxima (1029s, 925s). That spends a coordinator turn on a tail the late-delivery path already handles.

## Consequences

- `clampDelegateWaitTimeoutMs` still caps every wait at 895s. Hints that compute higher resolve to that ceiling, which is below the outer skill timeout, so the handler still emits the structured failure first.
- A specialist that runs past 895s is reported as a timeout and then delivered late. That is the accepted outcome for the extreme tail, not a sizing bug.
- The default wait and per-agent hints are sized to p99 of the pre-2026-09-20 baseline and must stay strictly inside this ceiling. A test loads every shipped agent and checks that.

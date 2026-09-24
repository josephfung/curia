# Scheduler bounded concurrency

**Status:** implemented (#1160).
**Decision:** detach scheduler publishes from the poll and cap in-flight agent runs. Do not serialize polls.

## Baseline (prod, re-validated 2026-09-23)

Source: `audit_log` on `office.josephfung.ca`, correlated by `conversation_id LIKE 'scheduler:%'`. Windows: 7d for runs, 14d for lateness, 45d for the daily peak.

| Metric | Value |
|---|---|
| Scheduler agent runs (7d) | 1110 |
| Run duration, `agent.task` → terminal event | avg 111.2s, p50 38.6s, p90 257.0s, max 3039.6s |
| Runs overlapping at least one other run | 559 / 1110 |
| Peak simultaneous in-flight runs | 3–6 per day (max 6 across 45d) |
| Fire lateness, `*/15 6-23 * * *` ceo-inbox job (14d, n=1001) | p50 15.3s, p90 45.8s, p99 95.8s, max 133.0s; 53 fires >60s late, 0 >300s |

Durations jumped after the 2026-09-20 standard-tier swap to `deepseek-v4.1-flash` (per-LLM-call p90 96s, p99 422s, about 5 calls per run).

## Why an `isPolling` guard was rejected

Firing is serial inside one poll, but a fresh `pollDueJobs()` starts every 30s regardless and picks up anything still due. That accidental overlap (3–6 in flight) is what keeps lateness acceptable. Without it, one 08:00 batch would drain at N × 111s, and p90 lateness would move from ~46s toward minutes.

An in-flight guard that skips a poll while another is running would remove that pressure valve. It is a regression, not a mitigation. Do not add it.

## What shipped

`pollDueJobs` claims due rows and returns. `bus.publish` of `schedule.fired` and `agent.task` runs on a detached promise. The bus still awaits subscribers, so that promise stays pending for the whole agent run. The cap counts slots, which are released when publish settles or when the recovery timeout below elapses.

The cap is `scheduler.maxInFlight`, default **8**. The measured peak is 6, and 559/1110 runs overlapped something else, so a cap of 6 would shed load on the busiest days in the sample — the days when deferral costs the most. 8 leaves that peak unchanged and still bounds the unbounded growth #1650 is about.

The poll's `SELECT` uses `LIMIT` = free slots and does not lock rows. A slot is reserved synchronously before the claim `UPDATE`, so two overlapping polls on one process cannot both pass the check. When the cap is full the poll claims nothing and logs, at `info`, how many due rows it left pending. Leftover jobs stay `pending` and are eligible next tick. Claiming them early would start the watchdog clock (`run_started_at`) before the agent runs.

A slot is not held until `bus.publish` resolves. `handleTask` has no wall-clock timeout, so a stalled run would otherwise keep the slot until process restart, and `recoverStuckJobs` would reset the row without freeing the slot. The slot is released when publish settles or when `computeRecoveryTimeout` elapses (the same `LEAST(expected × 7.5, expected + 3600)` horizon the watchdog uses), whichever comes first. The timeout logs at `warn` and does not cancel the agent. Only the accounting is bounded.

Publish rejection (not an agent failure — the bus swallows subscriber errors) reverts `running` → `pending` on the detached promise, but only for the generation it claimed: the `pendingJobs` entry for that task event, and the row only while `run_started_at` is still the timestamp the claim returned. A rejection that arrives after the slot timeout — once the watchdog has reset the row and a later poll has claimed it again — must not clear the newer run. Claim and payload errors before the handoff stay on the poll's own catch and are not generation-scoped, because no task event exists yet.

Mutual exclusion stays the atomic claim `UPDATE`: `status IN ('pending','failed')`, and for cron also `next_run_at <= now()` (#1124, #1159). `FOR UPDATE SKIP LOCKED` on the due-job read was removed. That lock ended when the `SELECT` returned, which is before `fireJob` claims the row, so it was not the mutex. The watchdog query in `recoverStuckJobs` still uses `SKIP LOCKED`; this change does not touch it.

Post-deploy check, not covered by CI: ceo-inbox `*/15` fire lateness should stay at or under the p90 45.8s / p99 95.8s baseline above.

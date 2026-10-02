# Coordinator scenario suite — design (#1956)

Part of #1954. Builds on the test-mode stack from #1966 / #1969.

## Goal

Behavioral tests for coordinator rules that only the prompt enforces, run on the
production prompt and the production standard-tier model, with a pass-rate gate
that can block a release.

## Shape

`pnpm scenarios [--model <id>] [--case <substr>] [--runs <n>]` runs every YAML case
in `tests/scenarios/cases/` N times (default 5) and exits non-zero when any
`critical` behavior passes fewer than 80% of its runs.

```
tests/scenarios/
  cli.ts            entry point, exit code
  loader.ts         YAML → ScenarioCase (validated; placeholders checked)
  stub-matcher.ts   subset matching (ported from curia-deploy)
  stub-layer.ts     ExecutionLayer wrapper: stubs + fail-closed policy
  stub-coverage.ts  committed per-case unstubbed-call record + gate (ported)
  seed.ts           real-row seeding, scoped views, cleanup
  harness.ts        stack + Dispatcher + BullpenDispatcher + bus capture
  assertions.ts     deterministic tool-call / reply checks
  judge.ts          LLM judge for prose behaviors, per run
  gate.ts           pass rates, critical gate
  cases/*.yaml
```

## Decisions

**Database.** The suite runs on the local dev database (the same one smoke uses), so
the coordinator sees the real principal and the registry production would boot with.
Seeded state is written as **real rows** through the real services and removed in a
`finally` after every run:

| State | How it's seeded | How it's kept out of the real instance's way |
|---|---|---|
| Sender contacts | `ContactService.createContact` + `linkIdentity` | `source: 'scenario-test'`, deleted after the run |
| `[ACTIVE OUTBOUND CONTEXT]` entries | `OutboundContextService.register` | The Dispatcher gets a view whose `getActive()` returns only this run's entries (each read through the real `getEntry` SQL). Rows are deleted after the run. |
| Bullpen threads | `BullpenService.openThread` | Runtimes get a view whose `getPendingThreadsForAgent()` returns only this run's threads (new `wrapBullpenService` stack option). Threads are deleted after the run. |
| Scheduler jobs | `scheduler-list` stub | Not written. The coordinator only sees jobs through `scheduler-list`, which test mode disables anyway; a real row would be fired by any scheduler that comes up later. |

Because a running instance *would* act on seeded entries and threads, the runner refuses
to start while another client is connected to the database (`pg_stat_activity`),
unless `--allow-other-connections` is passed.

**Stubs fail closed.** The wrapper answers a call from the case's stubs (subset match,
first match wins, `null` = argument absent). An unmatched call to a tool whose
`action_risk` is above `none`, or to `delegate`, returns a `<skill_error>` and is
counted as unstubbed; it never reaches the real tool. Read-only tools without a stub
pass through to the real layer (memory reads, `date-resolve`, …), as the issue allows.
`delegate` is always stubbed so no specialist ever runs.

**Capture.** The harness subscribes as the `system` layer and records `tool.invoke` /
`tool.result` for the coordinator, `agent.response` (the reply text, including
`NO_REPLY`), and `outbound.no_reply`. A run ends on the coordinator's
`agent.response` for the case's conversation, so a silent turn no longer times out.

**Two kinds of behavior.** A behavior with a `check:` is scored in code (tool called /
not called / argument subset / substring / call order / reply is `NO_REPLY` / reply
contains no internal names). A behavior without one is scored by the LLM judge
(gpt-4o, the smoke judge), which sees the inbound, every tool call with its arguments
and result, and the reply. Each run is judged on its own.

**Gate.** Pass rate per behavior = mean over runs (PASS 1, PARTIAL 0.5, MISS 0). A
`critical` behavior under 0.8 fails the suite. Default 5 runs: at 5 runs the 0.8 gate
means 4/5, which fails a truly 95%-reliable behavior 2.3% of the time; at 3 runs it
means 3/3 and fails it 14.3% of the time (arithmetic from curia-deploy's eval README).

**No real outbound.** The stack's gateway has no transport client; on top of that, every
send tool is fail-closed unless stubbed, and a stub never calls the real layer. A test
asserts both.

## Cases

1. Transfer-ownership: reply matching an entry with a `delegation_hint` → `delegate` to
   that specialist with the entry id in the brief, no direct answer (trivial "yes" and
   the voice-brain-parity fixtures).
2. Sweep-on-close: closing specialist result → `context-bridge-release`; interim result
   → entry left active.
3. `NO_REPLY` for an automated notification and a non-principal calendar decline.
4. Reply-shaped principal message, no block → asks what it refers to; same message from
   a non-principal → does not.
5. Scheduler edit vs create vs ambiguous.
6. Bullpen mention → `bullpen` reply, never a human channel.
7. Direct inbound email → reply returned as text, no `email-reply` / `email-send`.
8. `paused` delegate result → no re-delegation, honest progress.
9. Principal-facing reply names no tools, agents or systems.
10. External reply is first person singular and never addresses the principal.

## Out of this PR (PR 2)

Smoke pass/fail gate, per-case sender, tool calls to the smoke judge, triage of the 42
smoke cases, the CLAUDE.md release pre-flight, and the baseline numbers in
`docs/wip/2026-10-01-coordinator-context-baseline.md`.

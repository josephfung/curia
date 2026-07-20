# ADR-030: Opt-in, per-task warm browser session

Date: 2026-07-20
Status: Accepted

## Context

A long browser flow (e.g. a 60-question survey) can exceed an agent's per-wake turn
budget, so the work is split into scheduled subtasks that resume on later wakes. But a
live browser session did not survive that split: the `session_id` lived only in the
originating conversation (each wake starts a fresh conversation with empty history), and
it was never recorded on the task. A woken subtask therefore had no handle to the live
page and could not resume the in-flight flow.

Two properties are actually in play, and conflating them caused confusion:

- **The persistent profile** (`~/.curia/browser-profile`, `launchPersistentContext`):
  one per principal, shared across all non-incognito sessions, persisted on disk. Cookies,
  storage, logins, and history accumulate here and survive process restarts. This is where
  "returning user" / anti-bot warmth lives, and it is **always on**, independent of anything
  below.
- **The session/page** (a live tab + DOM): held in an in-memory map with a 30-minute idle
  TTL, keyed by a server-generated random UUID, and lost on process restart.

Alternatives considered for making a session outlive a wake:

1. **A single global "canonical" session** for the principal (omit `session_id` → always the
   one warm tab). Rejected: it collides across concurrent work. If a reservation task and a
   form-fill task both use the one tab, the second navigates the first's page away.
   Serialization only prevents *simultaneous* corruption, not *sequential* clobbering.
2. **A durable, restart-surviving session.** Rejected as out of scope: a live Playwright page
   is not serializable, so "durable" would mean re-driving the flow anyway. The persistent
   profile already gives the recoverable part (login/cookies/history).
3. **Opt-in, per-task warm session** (chosen).

## Decision

A task can pin its own browser session via `keep_warm: true` on the `web-browser` skill,
which sets `keepWarm` on the `BrowserSession`. A pinned session is exempt from the idle TTL
(and skipped by the sweep), so a parked task resumes the same live, logged-in page on a
later wake. Pinning is per-session: each task's session is a distinct page in the shared
persistent profile, so concurrent tasks never clobber one another while still sharing
cookies/logins. One-off browsing keeps a throwaway session as before (default `keepWarm:
false`).

Durability is deliberately honest: the **profile** survives a restart on disk; a live
**page** does not. On restart a pinned session's page is gone but the profile is intact, so
the agent re-navigates to the recorded URL and resumes from recorded progress. To surface
this, the skill returns `session_reused`: when a caller passes a `session_id`, `true` means
it reattached to the live page and `false` means that session had expired and a fresh one
was minted (re-navigate and resume). A pinned session is still bounded by an absolute-age cap
(`keepWarmMaxAgeMs`, default 2 hours) so a task that never releases it cannot leak a browser
tab indefinitely.

The agent is guided (via the shared task-management prompt) to record the exact `session_id`
verbatim plus the URL in the task's progress when parking browser work, and to reuse it on
wake. Anti-bot warmth is not a factor in this choice: it lives in the always-on persistent
profile, so opt-in costs nothing there. The primary bot-flag cause was the datacenter egress
IP (addressed separately by the residential proxy, curia#1446), not the fingerprint.

## Consequences

- A long browser task that must span wakes can resume its own live page, and concurrent
  browser tasks are isolated — no shared-tab collision.
- The common case is unaffected: batched actions (one call fills a whole form page) let most
  long flows finish in a single wake, so `keep_warm` is the fallback, not the default path.
- New surface: `keep_warm` input and `session_reused` output on `web-browser`; `keepWarm`
  on `BrowserSession`; `keepWarmMaxAgeMs` on `BrowserService`. `getOrCreateSession` gains a
  `keepWarm` opt (monotonic — upgrades a session to pinned, never auto-downgrades; release
  via `closeSession`).
- Accepted trade-offs: a pinned tab consumes browser memory until released or capped; a
  process restart still loses in-flight page state (re-navigation is expected, not a bug);
  and continuity depends on the agent recording and reusing the real `session_id`.

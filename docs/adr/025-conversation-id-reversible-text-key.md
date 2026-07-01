# ADR-025: conversation_id is a reversible TEXT key, not a UUID v5

Date: 2026-07-01
Status: Accepted

## Context

Early specs described `conversation_id` as a *"deterministic UUID v5 generated
from `channel:user_id:thread_id`"* ([spec 02](../specs/02-agent-system.md),
[spec 04](../specs/04-channels.md)). #16 tracked the follow-up work: add the v5
generator and migrate the `audit_log` / `working_memory` id columns from TEXT to
UUID (`ALTER COLUMN conversation_id TYPE UUID USING conversation_id::uuid`).

When we came to do it, exploration showed the premise no longer held. During
Phase 4 the channel adapters converged on **human-readable, reversible** keys,
because outbound routing needs to recover the reply target *from the id itself*:

| Channel | `conversation_id` | Outbound reversal |
|---|---|---|
| CLI | `cli:local:default` | n/a (single session) |
| Email | `email:<nylasThreadId>` | `conversationId.slice('email:'.length)` recovers the thread id for the reply |
| Signal | `signal:+15550001111` / `signal:group=<base64GroupId>` | split back to a phone number or group id |
| HTTP | client-supplied, or `http-<randomUUID()>` | n/a |

Three facts made the v5 migration the wrong move:

1. **v5 adds no determinism we lack.** The current keys are *already*
   deterministic (`email:<threadId>` always maps to the same id). v5 would only
   add opacity — at the cost of reversibility.
2. **v5 is one-way; reversibility is load-bearing.** A hash cannot be parsed back
   into a thread id / phone / group id, so every channel's outbound path would
   need the routing target stored elsewhere (payload metadata or a side table)
   plus a rewrite. Pure downside for outbound reply routing.
3. **None of the live formats cast to UUID.** `email:...`, `signal:...`,
   `signal:group=...`, `cli:local:default`, and client-supplied HTTP strings all
   fail `::uuid`, so the proposed one-line `ALTER` would error on essentially
   every existing row. Rewriting `conversation_id` on historical rows also sits
   badly against the append-only `audit_log` (trigger from migration 021;
   migration 070 was made a no-op precisely to preserve that immutability).

The spec was also **internally inconsistent**: [spec 04](../specs/04-channels.md)
annotated the type as `// deterministic UUID v5` while its own per-channel prose
described the reversible `email:<threadId>` / Signal / HTTP derivations that were
actually built. The implementation followed the prose; the type comment was a
stale aspiration from before the reversibility need surfaced.

Alternatives considered:

- **A. Do the migration as written (#16).** Add v5 generation, move routing
  targets to payload/side-table, rewrite all four adapters, backfill + `ALTER`
  both tables. Rejected: high risk/effort to *remove* a useful property
  (reversibility) and gain only opacity.
- **B. Keep TEXT, reconcile the spec to reality.** Chosen (below).
- **C. Cheaper opacity without a type migration** (tokenize just the sensitive
  segment). Deferred to #1296 — the one real benefit (PII) is pursued separately,
  not via a TEXT→UUID type change.

## Decision

**Keep `conversation_id` (and `task_id`, `parent_event_id`) as TEXT, and treat
the reversible channel-scoped key as the intended design.** #16 is resolved by
reconciling the specs to reality rather than by migrating:

- [spec 02](../specs/02-agent-system.md) and [spec 04](../specs/04-channels.md)
  now describe `conversation_id` as a deterministic, human-readable, *reversible*
  key stored as TEXT — not a UUID v5.
- [spec 01](../specs/01-memory-system.md) `working_memory` is corrected from the
  never-built `task_id UUID / key / value` shape to the real conversation-scoped
  `conversation_id TEXT / role / content` shape.

The three id columns have genuinely different natures, and TEXT is correct for
all of them:

- **`conversation_id`** — deliberately reversible; must *not* be an opaque UUID.
- **`parent_event_id`** — happens to hold event UUIDs (`randomUUID()` bus event
  ids), so it is UUID-castable, but stays TEXT for schema simplicity and because
  there is no FK to enforce. Migrating it alone buys nothing.
- **`audit_log.task_id`** — vestigial: the audit logger never writes it
  ("Phase 1 has no task concept"), so it is an always-NULL TEXT column. No
  migration target until it is actually populated.

## Consequences

**Positive**

- No risky migration against the append-only `audit_log`; historical audit rows
  keep the readable channel keys that let an operator trace a row to its channel.
- Outbound reply routing keeps working with a zero-cost string parse instead of a
  new lookup table or payload duplication.
- The specs stop contradicting themselves and now match the code.

**Trade-offs / accepted risks**

- The schema keeps three TEXT id columns rather than uniform UUIDs — a cosmetic
  inconsistency we accept in exchange for reversibility and zero migration risk.
- Reversible keys embed raw identifiers (notably Signal phone numbers) into the
  append-only `audit_log`. This is a real PII concern, tracked separately for
  future hardening in **#1296** — to be solved without giving up reversibility
  and without a TEXT→UUID migration.

**Follow-ups**

- #1296 — reduce PII in `audit_log.conversation_id` (opaque/tokenized routing).
- If `audit_log.task_id` is ever populated, revisit whether it should be UUID +
  FK to `tasks(id)` at that point.

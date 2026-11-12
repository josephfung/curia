# ADR-063: Only the principal commissions work

Date: 2026-11-12
Status: Proposed

## Context

An outside contact asked Curia whether it would put together a full curriculum on a topic for them, and Curia offered to. Nothing in the system would have stopped it. The same holds for editing someone's essay, running their project, or doing prospecting outreach for them. Each is real work done for someone other than the principal, on the principal's account. Implementation is tracked in #2569.

What exists today limits other things:

| Guard | What it limits | Why it misses this |
|---|---|---|
| Inbound rate limiter (`src/dispatch/rate-limiter.ts`) | Messages per sender per minute | A single polite message can commission a large job |
| Unknown-sender read-only mode (`src/agents/runtime.ts`) | What a `tier=unknown` sender can get | Prompt-only, and a `known` contact skips it. Organizations reach `known` automatically on a validated domain |
| Relay budget (ADR-049, #1320) | How often an outsider makes Curia message the principal | Protects attention, not work |
| Band review of sends (ADR-049) | An outsider steering Curia's outbound messages | Runs at send time, after the work is done |
| Contact permissions (`config/permissions.yaml`) | Data and actions (financials, calendar, sending as the CEO) | Has no notion of "may ask Curia to do work" |

Alternatives considered and rejected:

- **Gate specific tools or agents for outsiders** (web search, delegation to research-analyst). The kinds of work someone can commission are open-ended, so a list is never complete, and each entry blocks legitimate use (looking something up to answer a question about the principal's meeting).
- **A per-requester or daily cost budget.** Cost-based budgets are being retired (#1814). Cost also measures the wrong thing: a cheap commissioned job is still not the principal's work.
- **A stored "sponsor" or grant on the task or contact.** ADR-049 already rejected persisted mandates: operators can't fill them in well and they go stale. A new field threaded through derived tasks is also more machinery than the decision needs. The task originator and its lineage already say who asked.
- **Treat the principal being cc'd as authorization.** Too easy to game: cc the principal, then ask for anything.
- **Let the coordinator decide in its prompt.** The coordinator is the component that offered the curriculum. A decision made by the model being asked is a prompt rule, not a control.

## Decision

1. **Only the principal commissions work.** Every request from a non-principal originator is one of:
   - **Serves the principal**: scheduling with the principal, replying on a thread the principal is part of, a question the principal would want answered.
   - **Courtesy**: a quick answer or pointer, what a human EA does for a contact without asking.
   - **Commissioned work**: a deliverable or ongoing effort for the requester's own benefit.

   Commissioned work proceeds only when the principal asked for it. That is the principal's own instruction (a principal-originated task), or the principal's answer to Curia asking. Being cc'd is not authorization.

2. **The decision is made once, where the task starts.** The dispatcher classifies each inbound turn from a non-principal external originator with a separate judgment call on the fast tier. It uses what is already in context: the message, the thread history, the outbound-context block (ADR-019), and the originator. It does not use the coordinator. The verdict and its reason go to the audit log. Principal, system and agent originators are not classified.

3. **The verdict is a property of that turn, not a new data type.** It is stamped on the originating task's metadata the way `originator` is, and the dispatcher strips any channel-supplied value. Nothing propagates to derived tasks, because a turn in courtesy mode creates none. A message injected mid-turn (ADR-053) from a non-principal is classified too. A commissioned verdict moves the turn into courtesy mode, never out of it.

4. **Commissioned work without the principal runs in courtesy mode**, enforced in code:
   - **No work that outlives the turn.** The points where follow-on work is created (delegation, scheduled jobs, planned or resumable tasks) refuse when the turn is in courtesy mode. This is a short, stable list of the ways work can continue after a turn, not a list of kinds of work. Managing a project or running outreach can't happen without follow-on work, so it is caught here.
   - **A lower round cap**, so in-turn work stays courtesy-sized. It is a count, so it does not depend on cost tracking.

   The coordinator chooses the reply: light help, a graceful decline, or an offer to pass the request to the principal through the digest. It does not reveal the restriction mechanically ("I'm not allowed to").

5. **Volume is limited per sender per day, by count.** A daily request count for each non-principal sender, alongside the per-minute limiter, separates a colleague's handful of asks from hundreds of small requests that add up to one large job. Past the limit, requests go to the principal's digest with one "more is waiting" line, the pattern the relay budget uses. It is in memory, like the relay budget: an outsider cannot cause a restart.

6. **The classifier fails closed.** If the judgment call errors or times out, the turn runs in courtesy mode. The cost of a wrong closed call is a smaller reply. The cost of a wrong open call is unbounded work.

## Consequences

- One rule covers every kind of work without naming any: research, writing, project management and outreach all reduce to "who asked, and did the principal commission it".
- No new data type or table. The decision lives on the originating task, next to `originator`, and is consistent with ADR-045: authorization is decided upstream, and specialists do not re-adjudicate.
- Every non-principal turn costs one extra fast-tier call before the coordinator runs, and adds a little latency.
- A follow-up from someone the principal did hand work to, arriving on a fresh thread the classifier can't connect to the principal's instruction, gets a courtesy-sized reply and an offer to check. We accept that rather than store grants.
- The classifier is a model and will sometimes misjudge. The code limits (no follow-on work, round cap) bound what a wrong "serves the principal" verdict can cost. The band review of sends (ADR-049) still applies to anything that goes out.
- Small asks are not prevented, by design: a human EA handles those too. The daily count is what stops them from adding up.
- A standing grant ("this contact may always commission work") is deliberately left out. If one is ever needed, it is an addition to this rule, not a replacement for it.

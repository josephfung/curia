# ADR-059: Tools with no describer get one learned per deployment, stored as data

Date: 2026-11-04
Status: Accepted

## Context

Recent Activity and the console home's Hiccups tile describe tool calls through `src/activity/describers.ts`: one hand-written describer per shipped tool, with its words, its prominence and its time weight. A deployment also runs tools that file cannot know about. A custom agent that tracks expenses writes to a spreadsheet through an MCP server. Those calls had no describer, so the feed fell back to "looked into a request", and a failed write never marked the row partial or failed (#2455, from #2350 item 4).

Counting every undescribed call as an action would make things worse. Most undescribed tools are reads (`ceo-inbox-search`, `contact-lookup`, about 70 more), and a failed search the agent retries would become a hiccup. The feed needs two things for an undescribed tool: whether it reads or writes, and words for it. Both depend on the deployment: which MCP servers and custom agents it runs.

`action_risk` almost answers read or write. For local tools `none` means a read. But MCP tools get one `action_risk` for the whole server (`mcp-loader.ts`), and local tools at `low` include both internal writes and reads filed above `none` (`bullpen-read`, `meeting-agenda-load`). Tool names cannot be shown in the feed (`src/activity/types.ts`).

Alternatives considered:

- **Write a describer in code for every tool.** Impossible for MCP and custom tools, which differ per deployment.
- **Move the code describers into the table too, so there is one source.** They are logic, not templates: they resolve contact names, format event days in the principal's timezone, and vary minutes by call (a new document versus an edit). They change in the same PR as their `tool.json` and are unit tested. Seed rows in migrations would drift from production and clash with operator edits.
- **Ask the specialist agent to describe its own work.** A self-report is not grounded in tool outcomes and can call a failed write a success. Waking the specialist costs a full turn on its prompt, and a response field would grow every agent's prompt (ADR-046).
- **Extend the activity summarizer to these jobs.** One model call per job instead of per tool, wording that drifts from day to day, no effect on past jobs, and nothing the outcome SQL can read.
- **A hand-written per-tool hint in MCP config.** Works, but every operator has to write and keep one for every server.

## Decision

A fast-tier model writes a describer once per agent and undescribed tool, the first time that agent uses the tool, and Curia stores it in the `activity_describers` table. A row holds `effect` (`read` or `write`), a tally (`verb`, `one`, `many`, e.g. "logged" / "an expense" / "expenses"), an `attempt` for failures ("log an expense"), a fingerprint of the tool's description, schema and deterministic signal it was learned from, and a `source`.

**Lookup order:** code describer, then learned row, then fallback. A row for a tool that has a code describer is ignored.

**The model never decides an outcome.** Success and failure come only from `tool.result`. The model picks words, and read or write only when no deterministic signal exists:

| Tool | Signal |
|---|---|
| Local, `action_risk: none` | read |
| Local, `medium` or above | write |
| Local, `low` | none: the model decides |
| MCP, `readOnlyHint: true` | read |
| MCP, `readOnlyHint: false` or `destructiveHint: true` | write |
| MCP, no hints | none: the model decides |

`source` records where the row came from: `hint` (effect from a signal, words learned), `learned` (both from the model), or `operator` (edited by hand). The learner never overwrites an operator row; the upsert enforces this in SQL. A row is learned again when that fingerprint changes: a new description or schema, or a signal change such as a server adding `readOnlyHint` or an `action_risk` crossing a boundary. Without the signal in the fingerprint, a stored `read` would outrank the known-write fallback and hide that tool's failures. There is no principal UI; an operator edits the table when needed.

**What the feed shows.** A learned write is a tally ("logged 3 expenses"); a failed one marks the row partial beside successes, or failed alone. A learned read never counts toward the outcome; for a lookup-only job it replaces only the final "looked into a request" line, after the inbox, calendar and contacts rules. A known write with no row yet (pending or failed learning) counts as "took N actions". A tool with no row and no signal keeps the old behaviour: unnamed, never a hiccup.

**The histogram agrees.** `HISTOGRAM_SQL` joins `activity_describers` on the agent that made each call and applies the same rule, so the Hiccups tile, the histogram and the hiccup list count the jobs the feed marks.

**Display only.** Nothing in autonomy reads the table or the MCP annotations. A model's guess, or a server's claim about its own tool, must never lower a security gate. MCP's single `action_risk` per server remains a separate gap.

Rows are keyed by agent, not just tool, because the same tool means different things to different agents: a sheet append is "logged an expense" for one and "added a lead" for another.

## Consequences

- Custom agents' work shows in Recent Activity and the Hiccups tile without anyone writing a describer.
- The feed is projected from `audit_log` at read time, so once a row exists, earlier jobs using that tool re-render with it.
- Cost is one fast-tier call per new agent and tool pair, not per job. A failed call writes no row and is retried on a later sighting, no sooner than ten minutes.
- The learner skips reads the feed already names by family (inbox, calendar, contacts), since their learned phrase would never show.
- Wording quality depends on the model. Learned phrases are validated (plain words only, no digits, no tool name, no contact details); a phrase that fails validation leaves the generic line.
- Time saved is unchanged. Learned rows carry no minutes; undescribed successes still count `UNDESCRIBED_CALL_MINUTES` (ADR-058).
- Code describers stay in `describers.ts` and win over a learned row. The two sources mean different things: one is hand-written and versioned, the other learned per deployment and disposable.

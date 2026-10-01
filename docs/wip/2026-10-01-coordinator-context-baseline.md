# Coordinator per-call context baseline

Standing before/after log for the coordinator context diet (#1954 / #1955).
Append a section after each epic phase. Leave earlier sections in place.

The script is `scripts/report-agent-context.ts`. It is read-only: every statement
is a single `SELECT`, and the CLI sets the session to
`default_transaction_read_only` before running them.

## How to capture

`DATABASE_URL` is already in the app container. Do not use `pnpm run` — that
wrapper expects a `.env` the container does not have.

```bash
ssh -p 2222 <host> 'docker exec curia-curia-1 \
  ./node_modules/.bin/tsx scripts/report-agent-context.ts \
  --agent coordinator --days 30 --format markdown'
```

`<host>` is the office SSH alias (`ceo-office` in `docs/dev/google-drive.md`).
Paste the markdown under Captures. For a later phase, pass `--since` / `--until`
when the window should not be "the 30 days ending now".

## What the numbers are

- **System-string chars** — every `role=system` message in the archived prompt.
  That is the YAML prompt plus the blocks injected on that call. It is not the
  `context.budget` `system_prompt` tier, which is only the assembled system prompt.
- **Tool-definition bytes** — `octet_length` of the stored `tool_definitions`
  jsonb. **Source bytes** sum each tool object. **json-framing** is the array
  punctuation, so on one call the source bytes plus framing equal the total.
  Percentiles do not sum across rows.
- **Source split** — a tool whose name is on disk under `skills/**/tool.json`
  (or is a pinned bundle member) is `local`. When the agent pins exactly one
  MCP server, every other tool is charged to that server. The live membership
  is whatever showed up in `tool_definitions` during the window; MCP tool lists
  are not in the repo.
- **Provider input tokens** — `llm.call` `inputTokens`, `percentile_cont` p50
  and p95. Archive rows and token samples can differ when the archive
  kill-switch was off.
- **Context budget tiers** — estimated tokens of each injected block on the
  samples where it was included, plus how often it was dropped.
- **Pinned tools with zero calls** — local pins expanded from `agents/<name>.yaml`
  the way the runtime expands them, plus MCP tools that were offered in the
  window, minus `tool.invoke` / `skill.invoke` rows for that agent.
- **Modal tool count** — the tool-list size that appears most often (ties break
  toward the smaller count). Later calls in a task grow when `skill-activate`
  adds tools, so this slice is the usual fixed payload.

## Captures

### 2026-10-01 — production capture still outstanding

The script landed on this date. The production host was not reachable from the
environment that added it: there is no SSH key here, and `ceo-office` is an
operator alias rather than a resolvable name. Run the command above and paste
its markdown below this paragraph before any prompt change from #1954 merges.
That paste is the coordinator baseline the rest of the epic measures against.

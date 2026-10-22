# Voice brain parity spike harness (#1595 / ADR-038, #1968)

```bash
# Single run (arms: baseline, shared-hardening, slim-core, slim-core-system)
ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Variance (≥5 interleaved reps) — prefer variance.json over a point estimate
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Pick arms; ADR-038's full-consolidation arm is off by default
ARMS=baseline,full-consolidation REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Latency: arms × tool sets (none / voice / coordinator), cold and warm
ANTHROPIC_API_KEY=… REPS=10 pnpm exec tsx scripts/spikes/voice-brain-parity/latency-microbench.ts

# Another model: artifacts get a model suffix (variance.claude-haiku-5-5.json, …)
VOICE_SPIKE_MODEL=claude-haiku-5-5 REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Reasoning effort, both scripts: `none` is what voice's turn runner sends.
# Artifacts get an effort suffix (variance.claude-haiku-5-5.effort-none.json, …)
VOICE_SPIKE_MODEL=claude-haiku-5-5 VOICE_SPIKE_EFFORT=none REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
```

Set `VOICE_SPIKE_EFFORT=none` to match production on a model that thinks by default
(Haiku 5.5, Sonnet 5.5). Unset sends no reasoning option, so the model's default
effort applies; the unsuffixed 5.5 artifacts were run that way.

`slim-core` puts the voice module in the caller's message as turn guidance, the text
path's shape; `slim-core-system` appends it, and any outbound context, to the
coordinator's system string instead. Both scripts meter every call's usage and price
it from the model registry: `spend` in the variance file, `spendUsd` in the microbench.

Since #1968 every arm gets what production assembles (`production-context.ts`): the
specialist roster from `agents/`, voice's real tool definitions (`VOICE_TOOL_NAMES`),
and, for `slim-core`, the coordinator's per-turn system string from `assembleAgent` +
`buildBaseSystemPrompt`. No database is needed.

Committed artifacts: `fixtures.json`, `variance*.json` (multi-rep summaries; the
unsuffixed file is prod's voice model, claude-haiku-4-5), `latency-microbench*.json`,
and ADR-038's originals as `*-adr038.json`. `results*.json` is regenerated locally and
gitignored.

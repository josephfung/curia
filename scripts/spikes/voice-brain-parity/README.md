# Voice brain parity spike harness (#1595 / ADR-038)

```bash
# Single run
ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts

# Variance (≥5 interleaved reps) — prefer variance.json over a point estimate
ANTHROPIC_API_KEY=… REPS=5 pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
```

Committed artifacts: `fixtures.json`, `variance.json` (latest multi-rep summary),
`latency-microbench.json`. `results.json` is regenerated locally (gitignored when large).

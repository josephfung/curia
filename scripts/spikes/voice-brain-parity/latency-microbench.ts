#!/usr/bin/env tsx
// Latency microbench — one spoken turn per call, N reps per cell (#1595, #1968).
//
// ADR-038's version sent no tool definitions, so its numbers left out the largest
// part of every spoken request. This one crosses prompt arms with tool sets and
// measures each cell cold and warm:
//   - tool sets: none (ADR-038's bare turn), voice (VOICE_TOOL_NAMES, #1968), and
//     coordinator (the pins + discovery + async-offramp voice carried before #1968);
//   - cold: a fresh nonce heads the first tool's description and the system string,
//     so nothing in the prefix is cached (the first turn of a call, or one after the
//     5-minute cache TTL);
//   - warm: the identical request again straight after, so the tools and system
//     breakpoints (src/agents/llm/anthropic.ts) are read from cache.
// Cache read/write tokens are recorded per call, so a cell whose "warm" call did not
// hit the cache shows it.
//
//   ANTHROPIC_API_KEY=… pnpm exec tsx scripts/spikes/voice-brain-parity/latency-microbench.ts
//   VOICE_SPIKE_MODEL=claude-haiku-5-5 REPS=8 pnpm exec tsx …
//   VOICE_SPIKE_EFFORT=none …   (voice's reasoning setting; see production-context.ts)
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnthropicProvider } from '../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { estimateTokens } from '../../../src/agents/llm/token-estimator.js';
import type { LLMUsage, Message, ToolDefinition } from '../../../src/agents/llm/provider.js';
import {
  DATE_RESOLVE_GUARDRAIL,
  PRONOUN_RESOLUTION_GUARDRAIL,
  ROUTING_DECISION_GUARDRAIL,
  VOICE_ASYNC_OFFRAMP_GUIDANCE,
} from '../../../src/agents/prompts/index.js';
import {
  VOICE_DELEGATION_GUIDANCE,
  VOICE_SYSTEM_ADDENDUM,
  VOICE_TOOL_RESULT_POLICY,
  buildVoiceSystemPrompt,
} from '../../../src/channels/voice/voice-runtime.js';
import { createSilentLogger } from '../../../src/logger.js';
import { formatTimeContextBlock } from '../../../src/time/time-context.js';
import { createEstimateCostUsd } from '../../../src/agents/llm/pricing.js';
import {
  loadProductionVoiceContext,
  modelArtifactPath,
  renderVoiceSystemModule,
  renderVoiceTurnGuidance,
  spikeReasoningEffort,
} from './production-context.js';

const REPS = Number(process.env.REPS ?? 10);
const MODEL = process.env.VOICE_SPIKE_MODEL ?? 'claude-haiku-4-5';
const EFFORT = spikeReasoningEffort();
const OUT = modelArtifactPath(import.meta.dirname, 'latency-microbench', MODEL, EFFORT);
const UTTERANCE = 'Thanks, that is all for now.';

type ArmId = 'baseline' | 'shared-hardening' | 'slim-core' | 'slim-core-system';
type ToolSetId = 'none' | 'voice' | 'coordinator';

/** The cells worth paying for: #1968's before/after on the production prompt, and every arm on voice's tools. */
const CELLS: Array<{ arm: ArmId; tools: ToolSetId }> = [
  { arm: 'baseline', tools: 'none' },
  { arm: 'baseline', tools: 'coordinator' },
  { arm: 'baseline', tools: 'voice' },
  { arm: 'shared-hardening', tools: 'none' },
  { arm: 'shared-hardening', tools: 'voice' },
  { arm: 'slim-core', tools: 'none' },
  { arm: 'slim-core', tools: 'voice' },
  { arm: 'slim-core-system', tools: 'voice' },
];

interface ArmPrompt {
  system: string;
  /** Heads the user turn (slim-core's voice module, #1959). */
  turnGuidance: string | null;
}

interface Row {
  arm: ArmId;
  tools: ToolSetId;
  cache: 'cold' | 'warm';
  rep: number;
  ttftMs: number;
  fullMs: number;
  /** True when the model answered with a tool call — its "TTFT" is the full call. */
  calledTool: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  usd: number;
}

async function buildArms(): Promise<{ arms: Record<ArmId, ArmPrompt>; toolSets: Record<ToolSetId, ToolDefinition[]> }> {
  const fixtures = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'fixtures.json'), 'utf8'),
  ) as { anchor: { iso: string; timezone: string }; identityBlock: string };
  const ctx = loadProductionVoiceContext({ identityBlock: fixtures.identityBlock, timezone: fixtures.anchor.timezone });
  const now = new Date(fixtures.anchor.iso);
  const time = formatTimeContextBlock(fixtures.anchor.timezone, now);
  const baseline = buildVoiceSystemPrompt({
    identityBlock: fixtures.identityBlock,
    specialistRoster: ctx.specialistRoster,
    timeContextBlock: time,
    audience: { liveTurn: true },
  });
  // Same composition as run.ts's shared-hardening arm.
  const shared = [
    fixtures.identityBlock,
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    ROUTING_DECISION_GUARDRAIL,
    PRONOUN_RESOLUTION_GUARDRAIL,
    DATE_RESOLVE_GUARDRAIL,
    VOICE_ASYNC_OFFRAMP_GUIDANCE,
    VOICE_DELEGATION_GUIDANCE + '\n\n## Available Specialists\n' + ctx.specialistRoster,
    time,
  ].join('\n\n');
  return {
    arms: {
      baseline: { system: baseline, turnGuidance: null },
      'shared-hardening': { system: shared, turnGuidance: null },
      'slim-core': { system: await ctx.coordinatorSystemPrompt(now), turnGuidance: renderVoiceTurnGuidance() },
      'slim-core-system': {
        system: `${await ctx.coordinatorSystemPrompt(now)}\n\n${renderVoiceSystemModule()}`,
        turnGuidance: null,
      },
    },
    toolSets: { none: [], voice: ctx.voiceToolDefs, coordinator: ctx.coordinatorToolDefs },
  };
}

/** Prefix the nonce onto the system string and the first tool, so the whole cached prefix is new. */
function withNonce(prompt: ArmPrompt, tools: ToolDefinition[], nonce: string) {
  const tag = `[bench ${nonce}] `;
  return {
    system: tag + prompt.system,
    tools: tools.map((t, i) => (i === 0 ? { ...t, description: tag + t.description } : t)),
  };
}

async function oneCall(
  provider: AnthropicProvider,
  system: string,
  tools: ToolDefinition[],
  turnGuidance: string | null,
  estimate: (model: string, usage: LLMUsage) => number,
): Promise<Omit<Row, 'arm' | 'tools' | 'cache' | 'rep'>> {
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: turnGuidance ? `${turnGuidance}\n\n${UTTERANCE}` : UTTERANCE },
  ];
  const t0 = Date.now();
  let ttft: number | null = null;
  let usage: LLMUsage | undefined;
  let calledTool = false;
  for await (const event of provider.stream({
    messages,
    tools,
    model: MODEL,
    options: { signal: AbortSignal.timeout(60_000), ...(EFFORT ? { reasoning: { effort: EFFORT } } : {}) },
  })) {
    if (event.type === 'text_delta' && ttft === null) ttft = Date.now() - t0;
    if (event.type === 'message_end') usage = event.usage;
    if (event.type === 'tool_use') {
      usage = event.usage;
      calledTool = true;
    }
    if (event.type === 'error') throw new Error(`stream error: ${event.error.message}`);
  }
  const fullMs = Date.now() - t0;
  return {
    ttftMs: ttft ?? fullMs,
    fullMs,
    calledTool,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
    usd: usage ? estimate(MODEL, usage) : 0,
  };
}

function percentile(sorted: number[], p: number): number {
  // Nearest-rank: with 10 reps, p95 is the slowest call.
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');
  const logger = createSilentLogger();
  const provider = new AnthropicProvider(apiKey, logger, new ModelRegistry(logger));
  const estimate = createEstimateCostUsd(new ModelRegistry(logger), MODEL);
  const { arms, toolSets } = await buildArms();
  const rows: Row[] = [];

  // Interleave cells within each rep so drift in API latency spreads across all of them.
  for (let rep = 0; rep < REPS; rep++) {
    for (const cell of CELLS) {
      const prompt = arms[cell.arm];
      const { system, tools } = withNonce(prompt, toolSets[cell.tools], randomUUID());
      for (const cache of ['cold', 'warm'] as const) {
        const r = await oneCall(provider, system, tools, prompt.turnGuidance, estimate);
        rows.push({ arm: cell.arm, tools: cell.tools, cache, rep, ...r });
        process.stderr.write(
          `${cell.arm}/${cell.tools}/${cache} rep${rep}: ttft=${r.ttftMs} full=${r.fullMs} ` +
            `in=${r.inputTokens} cacheRead=${r.cacheReadInputTokens} cacheWrite=${r.cacheCreationInputTokens}` +
            `${r.calledTool ? ' (tool call)' : ''}\n`,
        );
      }
    }
  }

  const summary: Record<string, unknown> = {};
  for (const cell of CELLS) {
    const prompt = arms[cell.arm];
    for (const cache of ['cold', 'warm'] as const) {
      const subset = rows.filter(r => r.arm === cell.arm && r.tools === cell.tools && r.cache === cache);
      const ttfts = subset.map(r => r.ttftMs).sort((a, b) => a - b);
      const fulls = subset.map(r => r.fullMs).sort((a, b) => a - b);
      const avg = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
      summary[`${cell.arm}/${cell.tools}/${cache}`] = {
        n: subset.length,
        p50Ttft: percentile(ttfts, 0.5),
        p95Ttft: percentile(ttfts, 0.95),
        avgTtft: avg(ttfts),
        p50Full: percentile(fulls, 0.5),
        promptTokensEst: estimateTokens(prompt.system + (prompt.turnGuidance ?? '')),
        toolTokensEst: estimateTokens(JSON.stringify(toolSets[cell.tools])),
        toolCount: toolSets[cell.tools].length,
        avgCacheRead: avg(subset.map(r => r.cacheReadInputTokens)),
        avgCacheWrite: avg(subset.map(r => r.cacheCreationInputTokens)),
        avgUncachedInput: avg(subset.map(r => r.inputTokens)),
        avgOutput: avg(subset.map(r => r.outputTokens)),
        toolCallReps: subset.filter(r => r.calledTool).length,
      };
    }
  }
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: MODEL,
        reasoningEffort: EFFORT ?? 'model-default',
        reps: REPS,
        utterance: UTTERANCE,
        spendUsd: Math.round(rows.reduce((sum, r) => sum + r.usd, 0) * 1000) / 1000,
        summary,
        rows,
      },
      null,
      2,
    ),
  );
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});

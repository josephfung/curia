#!/usr/bin/env tsx
// Latency microbench — bare spoken turn (no tools), N reps per arm.
// Isolates prompt-size cost from tool-round variance.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { AnthropicProvider } from '../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { estimateTokens } from '../../../src/agents/llm/token-estimator.js';
import { runStreamingToolLoop } from '../../../src/agents/llm/streaming-turn.js';
import type { Message } from '../../../src/agents/llm/provider.js';
import {
  DATE_RESOLVE_GUARDRAIL,
  PRONOUN_RESOLUTION_GUARDRAIL,
  ROUTING_DECISION_GUARDRAIL,
} from '../../../src/agents/prompts/index.js';
import {
  VOICE_DELEGATION_GUIDANCE,
  VOICE_SYSTEM_ADDENDUM,
  VOICE_TOOL_RESULT_POLICY,
  buildVoiceSystemPrompt,
} from '../../../src/channels/voice/voice-runtime.js';
import { createSilentLogger } from '../../../src/logger.js';
import { formatTimeContextBlock } from '../../../src/time/time-context.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REPS = Number(process.env.REPS ?? 5);
const MODEL = process.env.VOICE_SPIKE_MODEL ?? 'claude-haiku-4-5';
const OUT = resolve(import.meta.dirname, 'latency-microbench.json');

function coordinatorPrompt(): string {
  const raw = yaml.load(readFileSync(resolve(REPO_ROOT, 'agents/coordinator.yaml'), 'utf8'));
  // Runtime check before narrowing the `unknown` yaml.load() result to the required-property shape.
  const doc = raw as unknown as { system_prompt?: string };
  if (!doc.system_prompt || typeof doc.system_prompt !== 'string') {
    throw new Error('coordinator.yaml missing system_prompt');
  }
  // Mirror production / run.ts: coordinator composes DATE_RESOLVE_GUARDRAIL at runtime.
  return `${doc.system_prompt}\n\n${DATE_RESOLVE_GUARDRAIL}`;
}

function prompts(): Record<string, string> {
  const fixtures = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'fixtures.json'), 'utf8'),
  ) as {
    anchor: { iso: string; timezone: string };
    identityBlock: string;
    specialistRoster: string;
  };
  const time = formatTimeContextBlock(fixtures.anchor.timezone, new Date(fixtures.anchor.iso));
  const baseline = buildVoiceSystemPrompt({
    identityBlock: fixtures.identityBlock,
    specialistRoster: fixtures.specialistRoster,
    timeContextBlock: time,
    audience: { liveTurn: true },
  });
  const shared = [
    fixtures.identityBlock,
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    ROUTING_DECISION_GUARDRAIL,
    PRONOUN_RESOLUTION_GUARDRAIL,
    DATE_RESOLVE_GUARDRAIL,
    VOICE_DELEGATION_GUIDANCE + '\n\n## Available Specialists\n' + fixtures.specialistRoster,
    time,
  ].join('\n\n');
  const full = [
    fixtures.identityBlock,
    coordinatorPrompt(),
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    '## Available Specialists\n' + fixtures.specialistRoster,
    time,
  ].join('\n\n');
  return { baseline, 'shared-hardening': shared, 'full-consolidation': full };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required');
  const logger = createSilentLogger();
  const provider = new AnthropicProvider(apiKey, logger, new ModelRegistry(logger));
  const all = prompts();
  // Interleave arms to dilute warm-cache bias across consecutive same-arm calls.
  const arms = Object.keys(all);
  const rows: Array<{ arm: string; rep: number; ttftMs: number; fullMs: number; tokens: number }> = [];

  for (let rep = 0; rep < REPS; rep++) {
    for (const arm of arms) {
      const system = all[arm]!;
      let ttft: number | null = null;
      const t0 = Date.now();
      const messages: Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: 'Thanks, that is all for now.' },
      ];
      await runStreamingToolLoop(messages, {
        provider,
        model: MODEL,
        tools: [],
        maxRounds: 1,
        signal: AbortSignal.timeout(60_000),
        hooks: {
          onTextDelta: () => {
            if (ttft === null) ttft = Date.now() - t0;
          },
        },
      });
      const fullMs = Date.now() - t0;
      const row = {
        arm,
        rep,
        ttftMs: ttft ?? fullMs,
        fullMs,
        tokens: estimateTokens(system),
      };
      rows.push(row);
      process.stderr.write(`${arm} rep${rep}: ttft=${row.ttftMs} full=${row.fullMs}\n`);
    }
  }

  const summary: Record<string, { n: number; avgTtft: number; p50Ttft: number; avgFull: number; tokens: number }> = {};
  for (const arm of arms) {
    const subset = rows.filter(r => r.arm === arm).map(r => r.ttftMs).sort((a, b) => a - b);
    const fulls = rows.filter(r => r.arm === arm).map(r => r.fullMs);
    summary[arm] = {
      n: subset.length,
      avgTtft: Math.round(subset.reduce((a, b) => a + b, 0) / subset.length),
      p50Ttft: subset[Math.floor(subset.length / 2)]!,
      avgFull: Math.round(fulls.reduce((a, b) => a + b, 0) / fulls.length),
      tokens: rows.find(r => r.arm === arm)!.tokens,
    };
  }
  writeFileSync(OUT, JSON.stringify({ model: MODEL, reps: REPS, summary, rows }, null, 2));
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});

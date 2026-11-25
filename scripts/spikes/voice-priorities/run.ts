#!/usr/bin/env tsx
// scripts/spikes/voice-priorities/run.ts
//
// Behaviour check for #2363: with the principal's priorities in the voice prompt,
// does Curia keep them as background (no unprompted mentions on ordinary calls)
// and still use them when asked or when a request clashes with one?
//
// The scenario suite drives the coordinator, never the voice runtime's prompt, so
// this runs production's own buildVoiceSystemPrompt on prod's voice model with
// voice's reasoning setting (none), voice's real tool definitions and roster
// (voice-brain-parity/production-context.ts). Tools answer with a generic success.
// The greeting is not run: it never carries the priorities (unit-tested).
//
// Scoring is deterministic: a reply "mentions" the priorities when its spoken text
// contains any of the fixture's priority keywords.
//
// Usage:
//   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/spikes/voice-priorities/run.ts
//   REPS=5 CASE=errand-reschedule pnpm exec tsx ...
//   VOICE_SPIKE_MODEL=claude-haiku-5-5 (default, prod's voice model)

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AnthropicProvider } from '../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import type { Message } from '../../../src/agents/llm/provider.js';
import { NO_REASONING } from '../../../src/agents/llm/sampling-options.js';
import { DEFAULT_STREAMING_MAX_ROUNDS, runStreamingToolLoop } from '../../../src/agents/llm/streaming-turn.js';
import { buildVoiceSystemPrompt, formatPrioritiesPromptBlock } from '../../../src/channels/voice/voice-runtime.js';
import { createSilentLogger } from '../../../src/logger.js';
import { formatTimeContextBlock } from '../../../src/time/time-context.js';
import { loadProductionVoiceContext, meterProvider } from '../voice-brain-parity/production-context.js';

const VOICE_MODEL = process.env.VOICE_SPIKE_MODEL?.trim() || 'claude-haiku-5-5';
const REPS = Number(process.env.REPS ?? '5');
const CASE_FILTER = process.env.CASE?.trim();
const PARITY_FIXTURES = resolve(import.meta.dirname, '../voice-brain-parity/fixtures.json');
const RESULTS_PATH = resolve(import.meta.dirname, 'results.json');

// Synthetic priorities, in the OKF shape workingDocsRepo.toOkf produces.
const PRIORITIES_DOC = `---
title: Priorities
as_of: 2026-07-20
---

## Close the Series A
Term sheet expected by mid-August. Partner meetings in Boston next Thursday and Friday.

## Hire a VP of Engineering
Two finalists; final interviews this week.

## Launch the Halifax office
Lease signed; opening in September.
`;

/** Words that only appear in talk about the priorities above. */
const PRIORITY_KEYWORDS = ['series a', 'term sheet', 'investor', 'vp of engineering', 'vp engineering', 'finalist', 'halifax', 'priorit'];

interface SpikeCase {
  id: string;
  utterance: string;
  /** True: the reply should bring the priorities in. False: it should not. */
  expectMention: boolean;
}

const CASES: SpikeCase[] = [
  { id: 'small-talk', utterance: "Hey, it's me. How's your day going?", expectMention: false },
  { id: 'errand-reschedule', utterance: 'Can you move my three o\'clock with Dana to tomorrow afternoon?', expectMention: false },
  { id: 'errand-email', utterance: 'Send Marco a note saying thanks for dinner last night.', expectMention: false },
  { id: 'focus-question', utterance: 'What should I be focusing on this week?', expectMention: true },
  {
    id: 'clashing-request',
    utterance: 'Block off next Thursday and Friday for a golf trip with the agency folks.',
    expectMention: true,
  },
];

interface Fixtures {
  anchor: { iso: string; timezone: string };
  identityBlock: string;
}

function mentions(text: string): string[] {
  const lower = text.toLowerCase();
  return PRIORITY_KEYWORDS.filter(keyword => lower.includes(keyword));
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  if (!Number.isInteger(REPS) || REPS < 1) throw new Error(`REPS must be a positive integer; got '${process.env.REPS}'`);

  const fixtures = JSON.parse(readFileSync(PARITY_FIXTURES, 'utf8')) as Fixtures;
  const logger = createSilentLogger();
  const { provider, meter } = meterProvider(new AnthropicProvider(apiKey, logger, new ModelRegistry(logger)), VOICE_MODEL);
  const ctx = loadProductionVoiceContext({ identityBlock: fixtures.identityBlock, timezone: fixtures.anchor.timezone });

  const system = buildVoiceSystemPrompt({
    identityBlock: fixtures.identityBlock,
    specialistRoster: ctx.specialistRoster,
    prioritiesBlock: formatPrioritiesPromptBlock(PRIORITIES_DOC),
    timeContextBlock: formatTimeContextBlock(fixtures.anchor.timezone, new Date(fixtures.anchor.iso)),
    audience: { liveTurn: true },
  });

  const cases = CASES.filter(c => !CASE_FILTER || c.id === CASE_FILTER);
  if (cases.length === 0) throw new Error(`no case matches CASE='${CASE_FILTER}'`);

  const results: Array<{ caseId: string; rep: number; ok: boolean; hits: string[]; tools: string[]; text: string }> = [];
  for (let rep = 1; rep <= REPS; rep++) {
    for (const spikeCase of cases) {
      meter.bucket = spikeCase.id;
      const tools: string[] = [];
      const messages: Message[] = [
        { role: 'system', content: system },
        { role: 'user', content: spikeCase.utterance },
      ];
      const result = await runStreamingToolLoop(messages, {
        provider,
        model: VOICE_MODEL,
        tools: ctx.voiceToolDefs,
        maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
        signal: AbortSignal.timeout(120_000),
        requestOptions: { reasoning: NO_REASONING },
        invokeTool: async (call) => {
          tools.push(call.name);
          return { content: JSON.stringify({ success: true, data: { status: 'done' } }) };
        },
      });
      // A failed or silent turn says nothing, which would score as "no mention": stop instead.
      if (result.stopReason !== 'message_end') {
        throw new Error(`${spikeCase.id} #${rep}: turn ended '${result.stopReason}' ${result.error ? JSON.stringify(result.error) : ''}`);
      }
      // Everything spoken across rounds, including text before a tool call.
      const text = result.streamedText || result.finalText;
      if (text.trim() === '') throw new Error(`${spikeCase.id} #${rep}: empty reply`);
      const hits = mentions(text);
      const ok = spikeCase.expectMention ? hits.length > 0 : hits.length === 0;
      results.push({ caseId: spikeCase.id, rep, ok, hits, tools, text });
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${spikeCase.id} #${rep}${hits.length ? ` [${hits.join(', ')}]` : ''}: ${text.replace(/\s+/g, ' ').slice(0, 160)}\n`);
    }
  }

  process.stdout.write('\nSummary\n');
  for (const spikeCase of cases) {
    const runs = results.filter(r => r.caseId === spikeCase.id);
    const passed = runs.filter(r => r.ok).length;
    process.stdout.write(`  ${spikeCase.id} (${spikeCase.expectMention ? 'should mention' : 'should not mention'}): ${passed}/${runs.length}\n`);
  }
  process.stdout.write(`  spend: $${meter.totalUsd().toFixed(4)} on ${VOICE_MODEL}\n`);

  writeFileSync(RESULTS_PATH, JSON.stringify({ model: VOICE_MODEL, reps: REPS, results, spend: meter.totals }, null, 2));
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

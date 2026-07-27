#!/usr/bin/env tsx
// scripts/spikes/voice-brain-parity/run.ts
//
// Research harness for #1595 / ADR-038. Runs a frozen voice-turn fixture against
// three prompt arms on the real voice model (claude-haiku-4-5 + stream()):
//   baseline          — today's buildVoiceSystemPrompt slim brain
//   shared-hardening  — slim brain + shared guardrail modules
//   full-consolidation — coordinator.yaml system_prompt + spoken addendum
//
// Measures time-to-first-token (proxy for time-to-first-audio) and full-turn
// latency; scores tool-call / spoken-behavior expectations from fixtures.json.
//
// Usage:
//   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
//   ARM=shared-hardening pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts  # one arm
//
// Writes results JSON next to this script. Not a CI gate — spike artifact.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { AnthropicProvider } from '../../../src/agents/llm/anthropic.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { estimateTokens } from '../../../src/agents/llm/token-estimator.js';
import {
  DEFAULT_STREAMING_MAX_ROUNDS,
  runStreamingToolLoop,
} from '../../../src/agents/llm/streaming-turn.js';
import type { Message, ToolCall, ToolDefinition } from '../../../src/agents/llm/provider.js';
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
const FIXTURES_PATH = resolve(import.meta.dirname, 'fixtures.json');
const RESULTS_PATH = resolve(import.meta.dirname, 'results.json');
const COORDINATOR_YAML = resolve(REPO_ROOT, 'agents/coordinator.yaml');
const VOICE_MODEL = process.env.VOICE_SPIKE_MODEL ?? 'claude-haiku-4-5';
const ARM_FILTER = process.env.ARM?.trim() || null;

interface FixtureCase {
  id: string;
  category: string;
  utterance: string;
  notes: string;
  toolOverrides?: Record<string, { content: string; is_error?: boolean }>;
  expect: {
    mustCallTools?: string[];
    shouldCallTools?: string[];
    mustNotCallTools?: boolean;
    delegateTargetHint?: string;
    spokenMustNotInventSchedule?: boolean;
    spokenShouldCorrect?: boolean;
    spokenMustNotClaimDoneWithoutTool?: boolean;
    spokenMustBeHonestNegative?: boolean;
    spokenMustNotClaimEmpty?: boolean;
    delegateBriefMustMentionPrincipal?: boolean;
    delegateBriefMustNotAssumePrincipal?: boolean;
  };
}

interface Fixtures {
  anchor: { iso: string; timezone: string; weekday: string };
  identityBlock: string;
  specialistRoster: string;
  outboundContextBlock: string | null;
  cases: FixtureCase[];
}

type ArmId = 'baseline' | 'shared-hardening' | 'full-consolidation';

interface ToolTrace {
  name: string;
  input: Record<string, unknown>;
}

interface CaseResult {
  arm: ArmId;
  caseId: string;
  category: string;
  promptTokensEst: number;
  ttftMs: number | null;
  fullTurnMs: number;
  toolRounds: number;
  toolsCalled: string[];
  toolTrace: ToolTrace[];
  finalText: string;
  stopReason: string;
  score: { passed: number; failed: number; checks: Array<{ id: string; ok: boolean; detail: string }> };
}

function loadCoordinatorSystemPrompt(): string {
  const raw = readFileSync(COORDINATOR_YAML, 'utf8');
  const doc = yaml.load(raw) as { system_prompt?: string };
  if (!doc.system_prompt || typeof doc.system_prompt !== 'string') {
    throw new Error('coordinator.yaml missing system_prompt');
  }
  return doc.system_prompt;
}

function buildPrompts(fixtures: Fixtures): Record<ArmId, string> {
  const now = new Date(fixtures.anchor.iso);
  const timeBlock = formatTimeContextBlock(fixtures.anchor.timezone, now);
  const outbound = fixtures.outboundContextBlock;

  const baseline = buildVoiceSystemPrompt({
    identityBlock: fixtures.identityBlock,
    specialistRoster: fixtures.specialistRoster,
    outboundContextBlock: outbound,
    timeContextBlock: timeBlock,
  });

  // Shared-hardening: compose extracted modules into the slim voice prompt.
  // Order mirrors coordinator salience: routing → pronouns → date-resolve,
  // then spoken addenda, then dynamic suffix (outbound + time).
  const sharedSections = [
    fixtures.identityBlock,
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    ROUTING_DECISION_GUARDRAIL,
    PRONOUN_RESOLUTION_GUARDRAIL,
    DATE_RESOLVE_GUARDRAIL,
    VOICE_DELEGATION_GUIDANCE + '\n\n## Available Specialists\n' + fixtures.specialistRoster,
  ];
  if (outbound) sharedSections.push(outbound);
  sharedSections.push(timeBlock);
  const sharedHardening = sharedSections.join('\n\n');

  // Full consolidation: coordinator brain + spoken-output post-processing layer.
  // Outbound-context injected exactly once (system suffix) — mirrors voice path,
  // not dispatcher user-content injection (avoid double-inject; #1594 trap).
  const fullSections = [
    fixtures.identityBlock,
    loadCoordinatorSystemPrompt(),
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    '## Available Specialists\n' + fixtures.specialistRoster,
  ];
  if (outbound) fullSections.push(outbound);
  fullSections.push(timeBlock);
  const fullConsolidation = fullSections.join('\n\n');

  return {
    baseline,
    'shared-hardening': sharedHardening,
    'full-consolidation': fullConsolidation,
  };
}

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'date-resolve',
    description:
      "Verify or resolve dates deterministically. Use for day-of-week or relative dates ('next Monday').",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        relative: { type: 'string' },
        expected_day: { type: 'string' },
      },
    },
  },
  {
    name: 'delegate',
    description:
      'Delegate work to a specialist agent. target is the specialist name (e.g. calendar). brief is the task.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        brief: { type: 'string' },
      },
      required: ['target', 'brief'],
    },
  },
];

function defaultToolResult(call: ToolCall, fixtures: Fixtures): { content: string; is_error?: boolean } {
  if (call.name === 'date-resolve') {
    const relative = typeof call.input.relative === 'string' ? call.input.relative.toLowerCase() : '';
    const date = typeof call.input.date === 'string' ? call.input.date : '';
    // Anchor Monday 2026-07-27 → next Tuesday = 2026-07-28; May 19 2026 = Tuesday.
    if (relative.includes('next tuesday') || relative.includes('tuesday')) {
      return {
        content: JSON.stringify({
          date: '2026-07-28',
          day_of_week: 'Tuesday',
          formatted: 'Tuesday, July 28, 2026',
          displayTimezone: 'EDT (UTC-04:00)',
        }),
      };
    }
    if (date.includes('2026-05-19') || date.toLowerCase().includes('may 19')) {
      const expected = typeof call.input.expected_day === 'string' ? call.input.expected_day : undefined;
      return {
        content: JSON.stringify({
          date: '2026-05-19',
          day_of_week: 'Tuesday',
          formatted: 'Tuesday, May 19, 2026',
          correct: expected ? expected.toLowerCase() === 'tuesday' : undefined,
          expected_day: expected,
          displayTimezone: 'EDT (UTC-04:00)',
        }),
      };
    }
    if (relative.includes('tomorrow') || relative.includes('friday') || relative.includes('this week')) {
      return {
        content: JSON.stringify({
          date: relative.includes('friday') ? '2026-07-31' : '2026-07-28',
          day_of_week: relative.includes('friday') ? 'Friday' : 'Tuesday',
          formatted: relative.includes('friday') ? 'Friday, July 31, 2026' : 'Tuesday, July 28, 2026',
          displayTimezone: 'EDT (UTC-04:00)',
        }),
      };
    }
    return {
      content: JSON.stringify({
        date: fixtures.anchor.iso.slice(0, 10),
        day_of_week: fixtures.anchor.weekday,
        formatted: 'Monday, July 27, 2026',
        displayTimezone: 'EDT (UTC-04:00)',
      }),
    };
  }

  if (call.name === 'delegate') {
    const target = String(call.input.target ?? '');
    const brief = String(call.input.brief ?? '');
    if (target.includes('calendar') || brief.toLowerCase().includes('calendar')) {
      return {
        content: JSON.stringify({
          success: true,
          data: {
            summary: 'One event: 1:1 with Jordan at 3:00 PM–3:30 PM.',
            events: [{ title: '1:1 with Jordan', start: '2026-07-28T15:00:00-04:00' }],
          },
        }),
      };
    }
    return {
      content: JSON.stringify({ success: true, data: { summary: 'Specialist completed the brief.' } }),
    };
  }

  return { content: JSON.stringify({ success: false, error: `unknown tool ${call.name}` }), is_error: true };
}

function scoreCase(
  fixture: FixtureCase,
  tools: ToolTrace[],
  finalText: string,
): CaseResult['score'] {
  const checks: CaseResult['score']['checks'] = [];
  const names = tools.map(t => t.name);
  const spoken = finalText.toLowerCase();
  const exp = fixture.expect;

  if (exp.mustNotCallTools) {
    checks.push({
      id: 'no-tools',
      ok: tools.length === 0,
      detail: tools.length === 0 ? 'no tools called' : `called ${names.join(',')}`,
    });
  }

  for (const t of exp.mustCallTools ?? []) {
    checks.push({
      id: `must-call-${t}`,
      ok: names.includes(t),
      detail: names.includes(t) ? `called ${t}` : `missing required ${t}; got [${names.join(',')}]`,
    });
  }

  for (const t of exp.shouldCallTools ?? []) {
    checks.push({
      id: `should-call-${t}`,
      ok: names.includes(t),
      detail: names.includes(t) ? `called ${t}` : `preferred ${t} not called; got [${names.join(',')}]`,
    });
  }

  if (exp.delegateTargetHint) {
    const del = tools.find(t => t.name === 'delegate');
    const target = String(del?.input.target ?? '').toLowerCase();
    const brief = String(del?.input.brief ?? '').toLowerCase();
    const ok = !!del && (target.includes(exp.delegateTargetHint) || brief.includes(exp.delegateTargetHint));
    checks.push({
      id: 'delegate-target',
      ok,
      detail: del
        ? `delegate target=${target || '(empty)'} brief=${brief.slice(0, 80)}`
        : 'no delegate call',
    });
  }

  if (exp.spokenMustBeHonestNegative) {
    const honest =
      /couldn'?t|could not|unable|failed|error|try again|not (able|reach)|unavailable|having trouble/.test(
        spoken,
      );
    checks.push({
      id: 'honest-negative',
      ok: honest,
      detail: honest ? 'spoken honest-negative phrasing' : `no honest-negative cues in: ${finalText.slice(0, 120)}`,
    });
  }

  if (exp.spokenMustNotClaimEmpty) {
    const emptyClaim = /clear|nothing (on|scheduled)|no (events|meetings)|free (all|the) day/.test(spoken);
    checks.push({
      id: 'no-false-empty',
      ok: !emptyClaim,
      detail: emptyClaim ? `false-empty claim in: ${finalText.slice(0, 120)}` : 'did not claim empty calendar',
    });
  }

  if (exp.spokenShouldCorrect) {
    const corrected = /tuesday|not a monday|actually/.test(spoken);
    const wrong = /\bis a monday\b|\byes[,.]?\s+may/.test(spoken) && !/not|actually|tuesday/.test(spoken);
    checks.push({
      id: 'date-correction',
      ok: corrected && !wrong,
      detail: `spoken=${finalText.slice(0, 160)}`,
    });
  }

  if (exp.spokenMustNotInventSchedule) {
    // If date-resolve wasn't called and model invents a specific meeting, fail.
    const invented = !names.includes('date-resolve') && /\b(meeting|at \d|o'?clock)\b/.test(spoken);
    checks.push({
      id: 'no-invented-schedule-without-date',
      ok: !invented,
      detail: invented ? 'invented schedule without date-resolve' : 'ok',
    });
  }

  if (exp.spokenMustNotClaimDoneWithoutTool) {
    const claimed = /\b(moved|done|rescheduled|updated)\b/.test(spoken);
    const ok = names.includes('delegate') || !claimed;
    checks.push({
      id: 'no-claim-done-without-delegate',
      ok,
      detail: ok ? 'ok' : `claimed completion without delegate: ${finalText.slice(0, 120)}`,
    });
  }

  if (exp.delegateBriefMustMentionPrincipal) {
    const del = tools.find(t => t.name === 'delegate');
    const brief = String(del?.input.brief ?? '').toLowerCase();
    const ok = !!del && /(principal|ceo|joseph|executive|the (user|caller)'s)/.test(brief);
    checks.push({
      id: 'pronoun-principal',
      ok,
      detail: del ? `brief=${brief.slice(0, 160)}` : 'no delegate',
    });
  }

  if (exp.delegateBriefMustNotAssumePrincipal) {
    const del = tools.find(t => t.name === 'delegate');
    const brief = String(del?.input.brief ?? '').toLowerCase();
    // Fail if brief says principal's calendar when the utterance was "your calendar".
    const assumedPrincipal = !!del && /principal'?s? calendar|ceo'?s? calendar/.test(brief) && !/(avery|office|your|agent|my own)/.test(brief);
    checks.push({
      id: 'pronoun-not-principal',
      ok: !assumedPrincipal,
      detail: del ? `brief=${brief.slice(0, 160)}` : 'no delegate (acceptable for clarification)',
    });
  }

  const passed = checks.filter(c => c.ok).length;
  const failed = checks.length - passed;
  return { passed, failed, checks };
}

async function runCase(
  arm: ArmId,
  systemPrompt: string,
  fixture: FixtureCase,
  fixtures: Fixtures,
  provider: AnthropicProvider,
): Promise<CaseResult> {
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: fixture.utterance },
  ];

  const toolTrace: ToolTrace[] = [];
  let ttftMs: number | null = null;
  const started = Date.now();

  const result = await runStreamingToolLoop(messages, {
    provider,
    model: VOICE_MODEL,
    tools: TOOL_DEFS,
    maxRounds: DEFAULT_STREAMING_MAX_ROUNDS,
    signal: AbortSignal.timeout(90_000),
    hooks: {
      onTextDelta: () => {
        if (ttftMs === null) ttftMs = Date.now() - started;
      },
    },
    invokeTool: async (call) => {
      toolTrace.push({ name: call.name, input: call.input });
      const override = fixture.toolOverrides?.[call.name];
      if (override) return override;
      return defaultToolResult(call, fixtures);
    },
  });

  const fullTurnMs = Date.now() - started;
  // If the model only tool-called then spoke, TTFT may land after tools — still record.
  if (ttftMs === null && result.finalText) ttftMs = fullTurnMs;

  return {
    arm,
    caseId: fixture.id,
    category: fixture.category,
    promptTokensEst: estimateTokens(systemPrompt),
    ttftMs,
    fullTurnMs,
    toolRounds: result.toolRounds,
    toolsCalled: toolTrace.map(t => t.name),
    toolTrace,
    finalText: result.finalText || result.streamedText,
    stopReason: result.stopReason,
    score: scoreCase(fixture, toolTrace, result.finalText || result.streamedText),
  };
}

function summarize(results: CaseResult[]) {
  const byArm: Record<string, {
    cases: number;
    checksPassed: number;
    checksFailed: number;
    avgTtftMs: number | null;
    avgFullTurnMs: number;
    p50FullTurnMs: number;
    promptTokensEst: number;
  }> = {};

  for (const arm of ['baseline', 'shared-hardening', 'full-consolidation'] as ArmId[]) {
    const rows = results.filter(r => r.arm === arm);
    if (rows.length === 0) continue;
    const fulls = rows.map(r => r.fullTurnMs).sort((a, b) => a - b);
    const ttfts = rows.map(r => r.ttftMs).filter((n): n is number => n !== null);
    byArm[arm] = {
      cases: rows.length,
      checksPassed: rows.reduce((s, r) => s + r.score.passed, 0),
      checksFailed: rows.reduce((s, r) => s + r.score.failed, 0),
      avgTtftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      avgFullTurnMs: Math.round(fulls.reduce((a, b) => a + b, 0) / fulls.length),
      p50FullTurnMs: fulls[Math.floor(fulls.length / 2)]!,
      promptTokensEst: rows[0]!.promptTokensEst,
    };
  }
  return byArm;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Fixtures;
  const prompts = buildPrompts(fixtures);
  const logger = createSilentLogger();
  const provider = new AnthropicProvider(apiKey, logger, new ModelRegistry(logger));

  const arms = (Object.keys(prompts) as ArmId[]).filter(a => !ARM_FILTER || a === ARM_FILTER);
  const results: CaseResult[] = [];

  process.stderr.write(`voice-brain-parity spike — model=${VOICE_MODEL} arms=${arms.join(',')}\n`);

  for (const arm of arms) {
    process.stderr.write(`\n=== arm: ${arm} (prompt ~${estimateTokens(prompts[arm])} tok) ===\n`);
    for (const fixture of fixtures.cases) {
      process.stderr.write(`  → ${fixture.id} ... `);
      try {
        const row = await runCase(arm, prompts[arm], fixture, fixtures, provider);
        results.push(row);
        const mark = row.score.failed === 0 ? 'PASS' : `FAIL(${row.score.failed})`;
        process.stderr.write(
          `${mark} ttft=${row.ttftMs ?? '-'}ms full=${row.fullTurnMs}ms tools=[${row.toolsCalled.join(',')}]\n`,
        );
      } catch (err) {
        process.stderr.write(`ERROR ${err instanceof Error ? err.message : String(err)}\n`);
        results.push({
          arm,
          caseId: fixture.id,
          category: fixture.category,
          promptTokensEst: estimateTokens(prompts[arm]),
          ttftMs: null,
          fullTurnMs: 0,
          toolRounds: 0,
          toolsCalled: [],
          toolTrace: [],
          finalText: '',
          stopReason: 'error',
          score: {
            passed: 0,
            failed: 1,
            checks: [{ id: 'run', ok: false, detail: err instanceof Error ? err.message : String(err) }],
          },
        });
      }
    }
  }

  const summary = summarize(results);
  const out = {
    generatedAt: new Date().toISOString(),
    model: VOICE_MODEL,
    fixturesPath: 'scripts/spikes/voice-brain-parity/fixtures.json',
    summary,
    results,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  process.stderr.write(`\nWrote ${RESULTS_PATH}\n`);
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});

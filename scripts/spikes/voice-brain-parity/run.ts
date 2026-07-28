#!/usr/bin/env tsx
// scripts/spikes/voice-brain-parity/run.ts
//
// Research harness for #1595 / ADR-038 (Proposed). Runs a frozen voice-turn
// fixture against three prompt arms on the real voice model
// (claude-haiku-4-5 + stream()):
//   baseline          — today's buildVoiceSystemPrompt (+ date-resolve module
//                       already composed in production)
//   shared-hardening  — slim brain + shared guardrails + async off-ramp
//   full-consolidation — coordinator.yaml system_prompt + spoken addendum
//
// Tools are load-bearing: calendar delegate rejects briefs lacking the ISO
// date that date-resolve should have produced. Counts are utterances ×
// assertion-checks — not an exhaustive suite.
//
// Usage:
//   ANTHROPIC_API_KEY=... pnpm exec tsx scripts/spikes/voice-brain-parity/run.ts
//   ARM=shared-hardening CASE=date-next-tuesday pnpm exec tsx ...

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

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const FIXTURES_PATH = resolve(import.meta.dirname, 'fixtures.json');
const RESULTS_PATH = resolve(import.meta.dirname, 'results.json');
const COORDINATOR_YAML = resolve(REPO_ROOT, 'agents/coordinator.yaml');
const VOICE_MODEL = process.env.VOICE_SPIKE_MODEL ?? 'claude-haiku-4-5';
const ARM_FILTER = process.env.ARM?.trim() || null;
const CASE_FILTER = process.env.CASE?.trim() || null;
const REPS = Math.max(1, Number(process.env.REPS ?? 1) || 1);
const VARIANCE_PATH = resolve(import.meta.dirname, 'variance.json');

interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface FixtureCase {
  id: string;
  category: string;
  utterance: string;
  notes?: string;
  history?: HistoryTurn[];
  outboundContextBlock?: string | null;
  toolOverrides?: Record<string, { content: string; is_error?: boolean }>;
  expect: {
    mustCallTools?: string[];
    shouldCallTools?: string[];
    mustCallToolsInOrder?: string[];
    mustNotCallTools?: boolean;
    delegateTargetHint?: string;
    delegateBriefMustContain?: string;
    spokenMustNotInventSchedule?: boolean;
    spokenShouldCorrect?: boolean;
    spokenMustNotClaimDoneWithoutTool?: boolean;
    spokenMustBeHonestNegative?: boolean;
    spokenMustNotClaimEmpty?: boolean;
    spokenMayClaimEmpty?: boolean;
    delegateBriefMustMentionPrincipal?: boolean;
    delegateBriefMustNotAssumePrincipal?: boolean;
    spokenMustNotAnswerSubstantively?: boolean;
    spokenMustNotMentionSpecialist?: boolean;
    spokenMustAcknowledgeOutbound?: boolean;
    spokenMustOfferAsyncOfframp?: boolean;
    spokenMustNotOfferAsyncOfframp?: boolean;
    spokenMustNotClaimFinishedHeavywork?: boolean;
    spokenMustConfirmHandoff?: boolean;
  };
}

interface Fixtures {
  anchor: { iso: string; timezone: string; weekday: string };
  identityBlock: string;
  specialistRoster: string;
  defaultOutboundContextBlock: string | null;
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
  // Mirror production: coordinator composes DATE_RESOLVE_GUARDRAIL at runtime
  // (no YAML stub). Full-consolidation arm must include it once.
  return `${doc.system_prompt}\n\n${DATE_RESOLVE_GUARDRAIL}`;
}

function buildPrompts(fixtures: Fixtures, outbound: string | null): Record<ArmId, string> {
  const now = new Date(fixtures.anchor.iso);
  const timeBlock = formatTimeContextBlock(fixtures.anchor.timezone, now);

  const baseline = buildVoiceSystemPrompt({
    identityBlock: fixtures.identityBlock,
    specialistRoster: fixtures.specialistRoster,
    outboundContextBlock: outbound,
    timeContextBlock: timeBlock,
  });

  // Shared-hardening: all staged modules + voice async off-ramp (the safety
  // mitigation that makes the slim brain non-regressive on heavyweight asks).
  const sharedSections = [
    fixtures.identityBlock,
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    ROUTING_DECISION_GUARDRAIL,
    PRONOUN_RESOLUTION_GUARDRAIL,
    DATE_RESOLVE_GUARDRAIL,
    VOICE_ASYNC_OFFRAMP_GUIDANCE,
    VOICE_DELEGATION_GUIDANCE + '\n\n## Available Specialists\n' + fixtures.specialistRoster,
  ];
  if (outbound) sharedSections.push(outbound);
  sharedSections.push(timeBlock);
  const sharedHardening = sharedSections.join('\n\n');

  // Full consolidation: coordinator brain + spoken addendum. Outbound injected
  // exactly once on the system suffix (voice path) — never also via dispatcher.
  const fullSections = [
    fixtures.identityBlock,
    loadCoordinatorSystemPrompt(),
    VOICE_SYSTEM_ADDENDUM,
    VOICE_TOOL_RESULT_POLICY,
    VOICE_ASYNC_OFFRAMP_GUIDANCE,
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
      "Verify or resolve dates deterministically. Use for day-of-week or relative dates ('next Monday', 'tomorrow').",
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
      'Delegate work to a specialist. target is the specialist name (calendar, contacts, ceo-inbox, research-analyst). brief is the task — include resolved ISO dates and entry_id when routing outbound-context replies.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        brief: { type: 'string' },
        entry_id: { type: 'string' },
      },
      required: ['target', 'brief'],
    },
  },
  {
    name: 'async-offramp',
    description:
      'Hand a heavyweight request off the live call to the async coordinator path. Use after the principal agrees to a follow-up, or when the ask is clearly async-shaped. brief: what to do; follow_up_channel: signal|email.',
    input_schema: {
      type: 'object',
      properties: {
        brief: { type: 'string' },
        follow_up_channel: { type: 'string' },
      },
      required: ['brief'],
    },
  },
];

/** Map relative expressions / known dates → ISO for load-bearing calendar checks. */
function resolveExpectedIso(call: ToolCall, fixtures: Fixtures): string | null {
  const relative = typeof call.input.relative === 'string' ? call.input.relative.toLowerCase() : '';
  const date = typeof call.input.date === 'string' ? call.input.date.toLowerCase() : '';
  if (relative.includes('next tuesday') || relative === 'tomorrow' || relative.includes('tomorrow')) {
    return '2026-07-28';
  }
  if (relative.includes('next friday') || relative.includes('friday')) return '2026-07-31';
  if (relative.includes('saturday')) return '2026-08-01';
  if (date.includes('2026-05-19') || date.includes('may 19')) return '2026-05-19';
  if (relative.includes('this week')) return fixtures.anchor.iso.slice(0, 10);
  return null;
}

function defaultDateResolveResult(call: ToolCall, fixtures: Fixtures): { content: string; is_error?: boolean } {
  const iso = resolveExpectedIso(call, fixtures) ?? fixtures.anchor.iso.slice(0, 10);
  const map: Record<string, { day: string; formatted: string }> = {
    '2026-07-28': { day: 'Tuesday', formatted: 'Tuesday, July 28, 2026' },
    '2026-07-31': { day: 'Friday', formatted: 'Friday, July 31, 2026' },
    '2026-08-01': { day: 'Saturday', formatted: 'Saturday, August 1, 2026' },
    '2026-05-19': { day: 'Tuesday', formatted: 'Tuesday, May 19, 2026' },
    '2026-07-27': { day: 'Monday', formatted: 'Monday, July 27, 2026' },
  };
  const meta = map[iso] ?? { day: fixtures.anchor.weekday, formatted: iso };
  const expected = typeof call.input.expected_day === 'string' ? call.input.expected_day : undefined;
  return {
    content: JSON.stringify({
      date: iso,
      day_of_week: meta.day,
      formatted: meta.formatted,
      correct: expected ? expected.toLowerCase() === meta.day.toLowerCase() : undefined,
      expected_day: expected,
      displayTimezone: 'EDT (UTC-04:00)',
    }),
  };
}

/** Natural-language forms date-resolve returns for our fixture dates. */
const DATE_ALIASES: Record<string, RegExp> = {
  '2026-07-28': /2026-07-28|july\s+28(?:th)?(?:,?\s*2026)?|28\s+july(?:\s+2026)?/i,
  '2026-07-31': /2026-07-31|july\s+31(?:st)?(?:,?\s*2026)?|31\s+july(?:\s+2026)?/i,
  '2026-08-01': /2026-08-01|august\s+1(?:st)?(?:,?\s*2026)?|1\s+august(?:\s+2026)?/i,
  '2026-05-19': /2026-05-19|may\s+19(?:th)?(?:,?\s*2026)?/i,
};

function briefContainsResolvedDate(brief: string, iso: string): boolean {
  if (brief.includes(iso)) return true;
  const alias = DATE_ALIASES[iso];
  return alias ? alias.test(brief) : false;
}

function defaultToolResult(
  call: ToolCall,
  fixtures: Fixtures,
  prior: ToolTrace[],
): { content: string; is_error?: boolean } {
  if (call.name === 'date-resolve') return defaultDateResolveResult(call, fixtures);

  if (call.name === 'async-offramp') {
    return {
      content: JSON.stringify({
        success: true,
        data: {
          accepted: true,
          follow_up_channel: call.input.follow_up_channel ?? 'email',
          note: 'Handed to async coordinator path; principal will be reached when done.',
        },
      }),
    };
  }

  if (call.name === 'delegate') {
    const target = String(call.input.target ?? '').toLowerCase();
    const brief = String(call.input.brief ?? '');
    const briefLower = brief.toLowerCase();
    const entryId =
      typeof call.input.entry_id === 'string'
        ? call.input.entry_id
        : (brief.match(/entry-[a-z0-9-]+/i)?.[0] ?? null);

    // Load-bearing calendar: require a resolved calendar date (ISO or the
    // natural form date-resolve returns) that date-resolve already produced.
    if (target.includes('calendar') || briefLower.includes('calendar')) {
      const priorDates = prior
        .filter(t => t.name === 'date-resolve')
        .map(t => {
          const fromRelative = resolveExpectedIso(
            { id: 'x', name: 'date-resolve', input: t.input },
            fixtures,
          );
          const explicit = typeof t.input.date === 'string' ? t.input.date : null;
          return fromRelative ?? explicit;
        })
        .filter((d): d is string => !!d);
      const matchedPrior = priorDates.find(iso => briefContainsResolvedDate(brief, iso));
      const anyKnownDate = Object.keys(DATE_ALIASES).find(iso => briefContainsResolvedDate(brief, iso));
      const needsDate =
        /\b(tomorrow|tuesday|friday|saturday|next |schedule|what's on|what is on|anything)\b/i.test(
          brief,
        ) || priorDates.length > 0;
      if (needsDate && priorDates.length === 0) {
        return {
          is_error: true,
          content: JSON.stringify({
            success: false,
            error:
              'calendar specialist requires date-resolve first — no resolved date was produced this turn',
          }),
        };
      }
      if (needsDate && priorDates.length > 0 && !matchedPrior) {
        return {
          is_error: true,
          content: JSON.stringify({
            success: false,
            error: `brief must include a date date-resolve produced this turn (${priorDates.join(', ')}); natural form OK (e.g. July 28, 2026)`,
          }),
        };
      }
      const isoForEvent = matchedPrior ?? anyKnownDate ?? '2026-07-28';
      return {
        content: JSON.stringify({
          success: true,
          data: {
            summary: 'One event: 1:1 with Jordan at 3:00 PM–3:30 PM.',
            events: [{ title: '1:1 with Jordan', start: `${isoForEvent}T15:00:00-04:00` }],
          },
        }),
      };
    }

    if (target.includes('ceo-inbox') || target.includes('inbox')) {
      return {
        content: JSON.stringify({
          success: true,
          data: {
            summary: entryId
              ? `Transfer-ownership accepted for ${entryId}; specialist will complete the reply.`
              : 'Inbox specialist accepted the brief.',
            entry_id: entryId,
          },
        }),
      };
    }

    if (target.includes('contact')) {
      return {
        content: JSON.stringify({
          success: true,
          data: {
            summary: 'Jordan Lee — product lead; email jordan@example.com; last met two weeks ago.',
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

  if (exp.mustCallToolsInOrder) {
    const seq = exp.mustCallToolsInOrder;
    let idx = 0;
    for (const name of names) {
      if (name === seq[idx]) idx += 1;
      if (idx >= seq.length) break;
    }
    const ok = idx >= seq.length;
    checks.push({
      id: 'tool-order',
      ok,
      detail: ok
        ? `order satisfied: ${seq.join(' → ')}`
        : `needed ${seq.join(' → ')}; got [${names.join(',')}]`,
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
        ? `delegate target=${target || '(empty)'} brief=${brief.slice(0, 100)}`
        : 'no delegate call',
    });
  }

  if (exp.delegateBriefMustContain) {
    const del = tools.find(t => t.name === 'delegate');
    const hay = `${String(del?.input.brief ?? '')} ${String(del?.input.entry_id ?? '')}`;
    const needle = exp.delegateBriefMustContain;
    const ok = !!del && (
      hay.includes(needle) ||
      (DATE_ALIASES[needle] ? DATE_ALIASES[needle]!.test(hay) : false)
    );
    checks.push({
      id: 'delegate-brief-contains',
      ok,
      detail: del
        ? ok
          ? `brief contains ${needle} (ISO or natural form)`
          : `missing ${needle} in: ${hay.slice(0, 160)}`
        : 'no delegate call',
    });
  }

  if (exp.spokenMustBeHonestNegative) {
    const honest =
      /couldn'?t|could not|unable|failed|error|try again|not (able|reach)|unavailable|having trouble|timed? ?out|still running/.test(
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

  if (exp.spokenMayClaimEmpty) {
    const emptyOk = /clear|nothing|no (events|meetings)|free/.test(spoken);
    checks.push({
      id: 'may-claim-empty',
      ok: emptyOk,
      detail: emptyOk ? 'reported empty success' : `expected empty-success phrasing: ${finalText.slice(0, 120)}`,
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
    const assumedPrincipal =
      !!del &&
      /principal'?s? calendar|ceo'?s? calendar/.test(brief) &&
      !/(avery|office|your|agent|my own)/.test(brief);
    checks.push({
      id: 'pronoun-not-principal',
      ok: !assumedPrincipal,
      detail: del ? `brief=${brief.slice(0, 160)}` : 'no delegate (acceptable for clarification)',
    });
  }

  if (exp.spokenMustNotAnswerSubstantively) {
    // Transfer-ownership: allow brief "on it" / "I'll route that" but not
    // composing the email / confirming Thursday to Sam as if we own it.
    const substantive =
      /(sent (it|the)|emailed|told sam|drafted|thursday works for (sam|them)|i'll send)/.test(spoken);
    checks.push({
      id: 'no-substantive-transfer-reply',
      ok: !substantive,
      detail: substantive
        ? `substantive reply under transfer-ownership: ${finalText.slice(0, 140)}`
        : 'no substantive takeover',
    });
  }

  if (exp.spokenMustNotMentionSpecialist) {
    const leaked = /(specialist|ceo-inbox|delegate tool|i (delegated|routed) to)/.test(spoken);
    checks.push({
      id: 'no-specialist-leak',
      ok: !leaked,
      detail: leaked ? `leaked machinery: ${finalText.slice(0, 120)}` : 'ok',
    });
  }

  if (exp.spokenMustAcknowledgeOutbound) {
    const ack = /(signal|google|alert|messaged|message(d)? you)/.test(spoken);
    checks.push({
      id: 'ack-outbound',
      ok: ack,
      detail: ack ? 'acknowledged outbound context' : `no outbound ack in: ${finalText.slice(0, 140)}`,
    });
  }

  if (exp.spokenMustOfferAsyncOfframp) {
    const offer =
      /(take a (bit|minute|while)|follow up|get back|work on it|email you|ping you|async|not (something|a thing) i can finish|too (much|large|big) for)/.test(
        spoken,
      );
    checks.push({
      id: 'offer-offramp',
      ok: offer,
      detail: offer ? 'offered async off-ramp' : `no off-ramp offer in: ${finalText.slice(0, 160)}`,
    });
  }

  if (exp.spokenMustNotOfferAsyncOfframp) {
    const offer = /(take a (bit|minute|while)|follow up in|work on it and)/.test(spoken);
    checks.push({
      id: 'no-spurious-offramp',
      ok: !offer,
      detail: offer ? `spurious off-ramp: ${finalText.slice(0, 140)}` : 'ok',
    });
  }

  if (exp.spokenMustNotClaimFinishedHeavywork) {
    const claimed = /(here('s| is) (the|your) (deck|briefing|summary)|i (finished|drafted|triaged) (all|everything))/.test(
      spoken,
    );
    checks.push({
      id: 'no-fake-heavy-finish',
      ok: !claimed,
      detail: claimed ? `claimed finished heavy work: ${finalText.slice(0, 140)}` : 'ok',
    });
  }

  if (exp.spokenMustConfirmHandoff) {
    const confirm = /(started|working on|follow up|email(ing)? you|handed|on it|queued)/.test(spoken);
    checks.push({
      id: 'confirm-handoff',
      ok: confirm && names.includes('async-offramp'),
      detail: `tools=[${names.join(',')}] spoken=${finalText.slice(0, 120)}`,
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
    ...(fixture.history ?? []).map(h => ({ role: h.role, content: h.content }) as Message),
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
    signal: AbortSignal.timeout(120_000),
    hooks: {
      onTextDelta: () => {
        if (ttftMs === null) ttftMs = Date.now() - started;
      },
    },
    invokeTool: async (call) => {
      const prior = [...toolTrace];
      toolTrace.push({ name: call.name, input: call.input });
      const override = fixture.toolOverrides?.[call.name];
      if (override) return override;
      return defaultToolResult(call, fixtures, prior);
    },
  });

  const fullTurnMs = Date.now() - started;
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
    utterances: number;
    assertionChecksPassed: number;
    assertionChecksFailed: number;
    avgTtftMs: number | null;
    avgFullTurnMs: number;
    p50FullTurnMs: number;
    promptTokensEst: number;
    failsByCategory: Record<string, number>;
  }> = {};

  for (const arm of ['baseline', 'shared-hardening', 'full-consolidation'] as ArmId[]) {
    const rows = results.filter(r => r.arm === arm);
    if (rows.length === 0) continue;
    const fulls = rows.map(r => r.fullTurnMs).sort((a, b) => a - b);
    const ttfts = rows.map(r => r.ttftMs).filter((n): n is number => n !== null);
    const failsByCategory: Record<string, number> = {};
    for (const r of rows) {
      if (r.score.failed > 0) {
        failsByCategory[r.category] = (failsByCategory[r.category] ?? 0) + r.score.failed;
      }
    }
    byArm[arm] = {
      utterances: rows.length,
      assertionChecksPassed: rows.reduce((s, r) => s + r.score.passed, 0),
      assertionChecksFailed: rows.reduce((s, r) => s + r.score.failed, 0),
      avgTtftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
      avgFullTurnMs: Math.round(fulls.reduce((a, b) => a + b, 0) / fulls.length),
      p50FullTurnMs: fulls[Math.floor(fulls.length / 2)]!,
      promptTokensEst: rows[0]!.promptTokensEst,
      failsByCategory,
    };
  }
  return byArm;
}

interface RepSummary {
  rep: number;
  byArm: ReturnType<typeof summarize>;
  /** caseId → whether all assertion-checks passed */
  casePass: Record<string, Record<string, boolean>>;
  /** category → { passedChecks, totalChecks } per arm */
  categoryChecks: Record<string, Record<string, { passed: number; total: number }>>;
}

function aggregateVariance(reps: RepSummary[], arms: ArmId[]) {
  const categories = new Set<string>();
  const caseIds = new Set<string>();
  for (const rep of reps) {
    for (const arm of arms) {
      for (const cat of Object.keys(rep.categoryChecks[arm] ?? {})) categories.add(cat);
      for (const id of Object.keys(rep.casePass[arm] ?? {})) caseIds.add(id);
    }
  }

  const overall: Record<string, {
    checkPassRateMean: number;
    checkPassRateMin: number;
    checkPassRateMax: number;
    utterancePassRateMean: number;
    utterancePassRateMin: number;
    utterancePassRateMax: number;
    perRep: Array<{ checksPassed: number; checksTotal: number; utterancesPassed: number; utterancesTotal: number }>;
  }> = {};

  for (const arm of arms) {
    const perRep = reps.map(rep => {
      const s = rep.byArm[arm]!;
      const checksPassed = s.assertionChecksPassed;
      const checksTotal = s.assertionChecksPassed + s.assertionChecksFailed;
      const caseMap = rep.casePass[arm] ?? {};
      const utterancesTotal = Object.keys(caseMap).length;
      const utterancesPassed = Object.values(caseMap).filter(Boolean).length;
      return { checksPassed, checksTotal, utterancesPassed, utterancesTotal };
    });
    const checkRates = perRep.map(r => r.checksPassed / Math.max(1, r.checksTotal));
    const utterRates = perRep.map(r => r.utterancesPassed / Math.max(1, r.utterancesTotal));
    overall[arm] = {
      checkPassRateMean: round3(mean(checkRates)),
      checkPassRateMin: round3(Math.min(...checkRates)),
      checkPassRateMax: round3(Math.max(...checkRates)),
      utterancePassRateMean: round3(mean(utterRates)),
      utterancePassRateMin: round3(Math.min(...utterRates)),
      utterancePassRateMax: round3(Math.max(...utterRates)),
      perRep,
    };
  }

  const byCategory: Record<string, Record<string, {
    checkPassRateMean: number;
    checkPassRateMin: number;
    checkPassRateMax: number;
    /** True when this arm's min rate is strictly above every other arm's max. */
    separatesAbove?: string[];
  }>> = {};

  for (const cat of [...categories].sort()) {
    byCategory[cat] = {};
    const ratesByArm: Record<string, number[]> = {};
    for (const arm of arms) {
      const rates = reps.map(rep => {
        const cell = rep.categoryChecks[arm]?.[cat];
        if (!cell || cell.total === 0) return 1;
        return cell.passed / cell.total;
      });
      ratesByArm[arm] = rates;
      byCategory[cat]![arm] = {
        checkPassRateMean: round3(mean(rates)),
        checkPassRateMin: round3(Math.min(...rates)),
        checkPassRateMax: round3(Math.max(...rates)),
      };
    }
    for (const arm of arms) {
      const mine = byCategory[cat]![arm]!;
      const above = arms.filter(other => {
        if (other === arm) return false;
        const o = byCategory[cat]![other]!;
        return mine.checkPassRateMin > o.checkPassRateMax;
      });
      if (above.length > 0) mine.separatesAbove = above;
    }
  }

  // Known hard cases called out in review.
  const caseFocus = ['pronoun-your-calendar', 'date-next-friday-meeting', 'date-next-tuesday'];
  const byCase: Record<string, Record<string, { passRateMean: number; passRateMin: number; passRateMax: number; passes: number; reps: number }>> = {};
  for (const caseId of caseFocus.filter(id => caseIds.has(id))) {
    byCase[caseId] = {};
    for (const arm of arms) {
      const flags = reps.map(rep => rep.casePass[arm]?.[caseId] ?? false);
      const rate = flags.filter(Boolean).length / flags.length;
      byCase[caseId]![arm] = {
        passRateMean: round3(rate),
        passRateMin: flags.every(Boolean) ? 1 : flags.some(Boolean) ? 0 : 0,
        passRateMax: flags.some(Boolean) ? 1 : 0,
        passes: flags.filter(Boolean).length,
        reps: flags.length,
      };
    }
  }

  // Paired analysis: arms are interleaved within each rep, so compare
  // per-rep deltas rather than marginal min/max ranges.
  const paired: {
    checkRate: Record<string, PairedDelta>;
    utteranceRate: Record<string, PairedDelta>;
    byCategory: Record<string, Record<string, PairedDelta>>;
  } = {
    checkRate: {},
    utteranceRate: {},
    byCategory: {},
  };

  const pairs: Array<{ key: string; a: ArmId; b: ArmId }> = [
    { key: 'shared-hardening−baseline', a: 'shared-hardening', b: 'baseline' },
    { key: 'shared-hardening−full-consolidation', a: 'shared-hardening', b: 'full-consolidation' },
    { key: 'baseline−full-consolidation', a: 'baseline', b: 'full-consolidation' },
  ].filter(p => arms.includes(p.a) && arms.includes(p.b));

  for (const { key, a, b } of pairs) {
    const checkDeltas = reps.map(rep => {
      const sa = rep.byArm[a]!;
      const sb = rep.byArm[b]!;
      const ra = sa.assertionChecksPassed / Math.max(1, sa.assertionChecksPassed + sa.assertionChecksFailed);
      const rb = sb.assertionChecksPassed / Math.max(1, sb.assertionChecksPassed + sb.assertionChecksFailed);
      return ra - rb;
    });
    const utterDeltas = reps.map(rep => {
      const ca = Object.values(rep.casePass[a] ?? {});
      const cb = Object.values(rep.casePass[b] ?? {});
      const ra = ca.filter(Boolean).length / Math.max(1, ca.length);
      const rb = cb.filter(Boolean).length / Math.max(1, cb.length);
      return ra - rb;
    });
    paired.checkRate[key] = summarizePairedDelta(checkDeltas);
    paired.utteranceRate[key] = summarizePairedDelta(utterDeltas);
  }

  for (const cat of [...categories].sort()) {
    paired.byCategory[cat] = {};
    for (const { key, a, b } of pairs) {
      const deltas = reps.map(rep => {
        const ca = rep.categoryChecks[a]?.[cat];
        const cb = rep.categoryChecks[b]?.[cat];
        const ra = !ca || ca.total === 0 ? 1 : ca.passed / ca.total;
        const rb = !cb || cb.total === 0 ? 1 : cb.passed / cb.total;
        return ra - rb;
      });
      paired.byCategory[cat]![key] = summarizePairedDelta(deltas);
    }
  }

  return { overall, byCategory, byCase, paired, reps: reps.length };
}

interface PairedDelta {
  mean: number;
  min: number;
  max: number;
  /** Per-rep deltas (a − b). */
  perRep: number[];
  positiveReps: number;
  negativeReps: number;
  zeroReps: number;
  /**
   * True when delta is >0 in ≥4/5 reps (or all reps when n<5) and never negative.
   * Correct win test for interleaved/paired arms — prefer over marginal min/max.
   */
  pairedWin: boolean;
}

function summarizePairedDelta(deltas: number[]): PairedDelta {
  const positiveReps = deltas.filter(d => d > 0).length;
  const negativeReps = deltas.filter(d => d < 0).length;
  const zeroReps = deltas.filter(d => d === 0).length;
  // For n≥5: ≥4 positive and never negative. For n<5: all positive.
  const pairedWin =
    negativeReps === 0 &&
    (deltas.length >= 5 ? positiveReps >= 4 : positiveReps === deltas.length);
  return {
    mean: round3(mean(deltas)),
    min: round3(Math.min(...deltas)),
    max: round3(Math.max(...deltas)),
    perRep: deltas.map(round3),
    positiveReps,
    negativeReps,
    zeroReps,
    pairedWin,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Fixtures;
  const cases = fixtures.cases.filter(c => !CASE_FILTER || c.id === CASE_FILTER);
  const logger = createSilentLogger();
  const provider = new AnthropicProvider(apiKey, logger, new ModelRegistry(logger));

  // Prompt size sample (no outbound) for the summary header.
  const samplePrompts = buildPrompts(fixtures, fixtures.defaultOutboundContextBlock);
  const arms = (Object.keys(samplePrompts) as ArmId[]).filter(a => !ARM_FILTER || a === ARM_FILTER);
  const allResults: CaseResult[] = [];
  const repSummaries: RepSummary[] = [];

  process.stderr.write(
    `voice-brain-parity spike — model=${VOICE_MODEL} arms=${arms.join(',')} ` +
      `utterances=${cases.length} reps=${REPS} (assertion-checks vary per case)\n`,
  );

  for (let rep = 0; rep < REPS; rep++) {
    process.stderr.write(`\n######## rep ${rep + 1}/${REPS} ########\n`);
    const results: CaseResult[] = [];
    // Interleave arms within a rep to dilute warm-cache bias across consecutive same-arm calls.
    for (const fixture of cases) {
      const outbound =
        fixture.outboundContextBlock !== undefined
          ? fixture.outboundContextBlock
          : fixtures.defaultOutboundContextBlock;
      const prompts = buildPrompts(fixtures, outbound);
      for (const arm of arms) {
        process.stderr.write(`  [r${rep}:${arm}] ${fixture.id} ... `);
        try {
          const row = await runCase(arm, prompts[arm], fixture, fixtures, provider);
          results.push(row);
          const mark = row.score.failed === 0 ? 'PASS' : `FAIL(${row.score.failed}/${row.score.passed + row.score.failed})`;
          process.stderr.write(
            `${mark} ttft=${row.ttftMs ?? '-'}ms full=${row.fullTurnMs}ms tools=[${row.toolsCalled.join(',')}]\n`,
          );
          if (row.score.failed > 0) {
            for (const c of row.score.checks.filter(x => !x.ok)) {
              process.stderr.write(`      ✗ ${c.id}: ${c.detail}\n`);
            }
          }
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

    allResults.push(...results);
    const casePass: RepSummary['casePass'] = {};
    const categoryChecks: RepSummary['categoryChecks'] = {};
    for (const arm of arms) {
      casePass[arm] = {};
      categoryChecks[arm] = {};
      for (const row of results.filter(r => r.arm === arm)) {
        casePass[arm]![row.caseId] = row.score.failed === 0;
        const cell = categoryChecks[arm]![row.category] ?? { passed: 0, total: 0 };
        cell.passed += row.score.passed;
        cell.total += row.score.passed + row.score.failed;
        categoryChecks[arm]![row.category] = cell;
      }
    }
    repSummaries.push({
      rep,
      byArm: summarize(results),
      casePass,
      categoryChecks,
    });
  }

  const summary = summarize(allResults);
  const variance = REPS > 1 ? aggregateVariance(repSummaries, arms) : null;
  const out = {
    generatedAt: new Date().toISOString(),
    model: VOICE_MODEL,
    reps: REPS,
    fixturesPath: 'scripts/spikes/voice-brain-parity/fixtures.json',
    countingNote:
      'Report as N utterances / M assertion-checks — not "N tests". Tools are load-bearing for date-resolve. ' +
      'When reps>1, prefer variance.json overall/byCategory pass-rate mean±range over a single point estimate.',
    summary,
    variance,
    results: allResults,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
  if (variance) {
    writeFileSync(VARIANCE_PATH, JSON.stringify({ generatedAt: out.generatedAt, model: VOICE_MODEL, ...variance }, null, 2));
    process.stderr.write(`\nWrote ${VARIANCE_PATH}\n`);
    process.stderr.write(JSON.stringify(variance.overall, null, 2) + '\n');
    process.stderr.write('paired check-rate deltas (a−b):\n');
    for (const [key, stats] of Object.entries(variance.paired.checkRate)) {
      process.stderr.write(
        `  ${key}: mean=${stats.mean} [${stats.min},${stats.max}] ` +
          `+${stats.positiveReps}/-${stats.negativeReps}/0${stats.zeroReps} ` +
          `pairedWin=${stats.pairedWin} perRep=${JSON.stringify(stats.perRep)}\n`,
      );
    }
    process.stderr.write('byCategory separations / paired wins vs baseline:\n');
    for (const [cat, armsMap] of Object.entries(variance.byCategory)) {
      for (const [arm, stats] of Object.entries(armsMap)) {
        const sep = stats.separatesAbove?.length
          ? ` separates↑ ${stats.separatesAbove.join(',')}`
          : '';
        process.stderr.write(
          `  ${cat}/${arm}: mean=${stats.checkPassRateMean} [${stats.checkPassRateMin},${stats.checkPassRateMax}]${sep}\n`,
        );
      }
      const pairedSb = variance.paired.byCategory[cat]?.['shared-hardening−baseline'];
      if (pairedSb) {
        process.stderr.write(
          `  ${cat} paired shared−baseline: mean=${pairedSb.mean} win=${pairedSb.pairedWin}\n`,
        );
      }
    }
  }
  process.stderr.write(`\nWrote ${RESULTS_PATH}\n`);
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});

// band-grounding-replay.ts — run the band brief's grounding cases against a real judge model
// (#2616) and report the error rates by label: how often a must-flag case is caught, and how
// often a must-pass case's send would go through. A judge that passes everything and one that
// blocks everything both look fine on one of those numbers alone (#2078 item 5).
//
// It calls the production EscalationJudge.review(), so the system prompt, temperature, token
// cap, reasoning setting and verdict parser are exactly what band review uses. Only the model
// is chosen here, and it must be one production could run: an exact registry entry whose
// thinking can be turned off. The model that actually answered is read from each call's
// llm.call telemetry; a run answered by another model counts as a failure, not a result.
//
// COSTS MONEY: every run is a real model call per case (cases × runs calls, about 3-4k input
// tokens each). Ask before running it (principles.md, "Testing and cost"). The script prints
// the estimated spend from the same telemetry. It exits 1 when any run failed.
//
// Usage:
//   pnpm exec tsx --env-file=.env scripts/judge-replay/band-grounding-replay.ts \
//     --model google/gemini-3.1-flash-lite [--runs 5] [--case <id>] [--json <out.json>]
// The provider key comes from the vault (anthropic_api_key or openrouter_api_key), so it needs
// DATABASE_URL and SECRET_ENCRYPTION_KEY, as the other vault-reading scripts do. Nothing is
// written anywhere but stdout and the --json file: no prompts, no responses, no key.

import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import pino from 'pino';
import { EscalationJudge } from '../../src/autonomy/escalation-judge.js';
import type { BriefAnswers } from '../../src/autonomy/judge-brief.js';
import { STAKES_MIN_SCORE } from '../../src/dispatch/band-send-review.js';
import { ModelRegistry } from '../../src/agents/llm/model-registry.js';
import { LLMProviderRouter } from '../../src/agents/llm/provider-router.js';
import { AnthropicProvider } from '../../src/agents/llm/anthropic.js';
import { OpenRouterProvider } from '../../src/agents/llm/openrouter.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import type { EventBus } from '../../src/bus/bus.js';
import { loadEncryptionKey } from '../../src/secrets/crypto.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { GROUNDING_CASES, groundingMeetsLabel, type GroundingCase } from './band-grounding-cases.js';

/** The score the cases run at: spot-check, where the production case ran (80-89). */
export const REPLAY_SCORE = 85;

/** One judge answer, kept whole so a hold for another reason is visible. */
export type RunAnswer =
  | { ok: true; actualModel: string | null; unsupportedClaims: string[]; unnecessaryItems: string[]; purpose?: string; speaksAsPrincipal?: boolean; stakes?: string }
  | { ok: false; failure: string };

export interface CaseResult {
  id: string;
  expect: GroundingCase['expect'];
  runs: number;
  /** Runs whose answer met the label. */
  met: number;
  /** Runs where the judge failed or another model answered: never counted as met. */
  failures: number;
  answers: RunAnswer[];
}

export interface LabelCount { met: number; runs: number; rate: number | null }

export interface ReplaySummary {
  model: string;
  runs: number;
  /** Must-flag runs caught. */
  flag: LabelCount;
  /** Must-pass runs whose send would go through. */
  pass: LabelCount;
  failures: number;
  estimatedCostUsd: number;
  cases: CaseResult[];
}

/**
 * Whether band review would let this send go at REPLAY_SCORE (src/dispatch/band-send-review.ts
 * otherRulesOutcome): serving, nothing unsupported, nothing unneeded, and no speaks-for-the-
 * principal hold at this score. A must-pass case is met only then, so a false positive moved
 * from grounding into another answer still counts against it.
 */
export function wouldSend(answers: BriefAnswers, score = REPLAY_SCORE): boolean {
  if (answers.purpose !== 'serving') return false;
  if ((answers.unsupportedClaims ?? []).length > 0) return false;
  if ((answers.unnecessaryItems ?? []).length > 0) return false;
  if (answers.speaksAsPrincipal === true) {
    const min = STAKES_MIN_SCORE[answers.stakes ?? 'financial_or_legal'];
    if (min === null || score < min) return false;
  }
  return true;
}

/** Whether one complete answer meets the case's label. */
export function meetsLabel(testCase: GroundingCase, answers: BriefAnswers): boolean {
  if (testCase.expect === 'pass') return wouldSend(answers);
  return groundingMeetsLabel(testCase, answers.unsupportedClaims ?? []);
}

/** Rates by label. A judge failure counts against the case either way: it decides nothing. */
export function summarize(model: string, runs: number, cases: CaseResult[], estimatedCostUsd = 0): ReplaySummary {
  const count = (label: GroundingCase['expect']): LabelCount => {
    const of = cases.filter((c) => c.expect === label);
    const total = of.reduce((n, c) => n + c.runs, 0);
    const met = of.reduce((n, c) => n + c.met, 0);
    return { met, runs: total, rate: total === 0 ? null : met / total };
  };
  return {
    model,
    runs,
    flag: count('flag'),
    pass: count('pass'),
    failures: cases.reduce((n, c) => n + c.failures, 0),
    estimatedCostUsd,
    cases,
  };
}

export interface Args { model: string; runs: number; caseId?: string; jsonOut?: string }

const FLAGS = new Set(['--model', '--runs', '--case', '--json']);

/** Strict: every argument is a known flag followed by a value. Anything else is an error, never ignored. */
export function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (!FLAGS.has(flag)) throw new Error(`unknown argument '${flag}' (use --model, --runs, --case, --json, each followed by a value)`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} given twice`);
    values.set(flag, value);
  }
  const model = values.get('--model');
  if (!model) throw new Error('--model is required (the judge model, as escalation.judge.model names it)');
  const runsRaw = values.get('--runs') ?? '5';
  const runs = Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 to 20');
  const caseId = values.get('--case');
  if (caseId !== undefined && !GROUNDING_CASES.some((c) => c.id === caseId)) {
    throw new Error(`--case ${caseId} is not one of: ${GROUNDING_CASES.map((c) => c.id).join(', ')}`);
  }
  return { model, runs, caseId, jsonOut: values.get('--json') };
}

/** Whether the model that answered is the one asked for (a dated variant of it counts). */
export function sameModel(requested: string, actual: string): boolean {
  return actual === requested || actual.startsWith(`${requested}-`);
}

interface CallTelemetry { actualModel: string; estimatedCostUsd: number }

/** Keeps each llm.call's model and cost; nothing else (the archive's prompt is dropped). */
function capturingBus(sink: CallTelemetry[]): EventBus {
  return {
    publish: async (_layer: string, event: { type?: string; payload?: Record<string, unknown> }) => {
      if (event.type !== 'llm.call' || !event.payload) return;
      const actualModel = event.payload['actualModel'];
      const cost = event.payload['estimatedCostUsd'];
      sink.push({ actualModel: typeof actualModel === 'string' ? actualModel : '', estimatedCostUsd: typeof cost === 'number' ? cost : 0 });
    },
  } as unknown as EventBus;
}

async function readProviderKey(provider: string, logger: pino.Logger): Promise<string> {
  const vaultKey = provider === 'anthropic' ? 'anthropic_api_key' : provider === 'openrouter' ? 'openrouter_api_key' : undefined;
  if (!vaultKey) throw new Error(`provider '${provider}' is not supported by this script (anthropic or openrouter)`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error(`DATABASE_URL is not set, so ${vaultKey} cannot be read from the vault`);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const key = (await new SecretsService(pool, loadEncryptionKey(), logger).get(vaultKey))?.trim();
    if (!key) throw new Error(`${vaultKey} is not in the vault`);
    return key;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const logger = pino({ level: 'warn' });
  const registry = new ModelRegistry(logger);
  // An exact entry, as production's config check needs in effect: a prefix match would price
  // and route a model nobody configured.
  if (!Object.hasOwn(registry.getAllModels(), args.model)) throw new Error(`model '${args.model}' has no exact entry in the model registry`);
  // Production refuses a judge slot whose thinking cannot be turned off (small-cap-models.ts).
  if (!registry.canTurnThinkingOff(args.model)) throw new Error(`model '${args.model}' cannot run with thinking off, so production would not run it as the judge`);
  const providerName = registry.getProvider(args.model);
  if (!providerName) throw new Error(`model '${args.model}' has no provider in the registry`);
  const key = await readProviderKey(providerName, logger);
  const provider: LLMProvider = providerName === 'anthropic'
    ? new AnthropicProvider(key, logger, registry)
    : new OpenRouterProvider(key, logger, registry);
  const router = new LLMProviderRouter(registry, new Map([[providerName, provider]]));
  const telemetry: CallTelemetry[] = [];
  // config/default.yaml escalation.judge: timeout_ms 5000, review_timeout_ms 15000.
  const judge = new EscalationJudge(router, { enabled: true, model: args.model, timeoutMs: 5000, reviewTimeoutMs: 15000 }, capturingBus(telemetry), logger, registry);

  const cases = GROUNDING_CASES.filter((c) => args.caseId === undefined || c.id === args.caseId);
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const result: CaseResult = { id: testCase.id, expect: testCase.expect, runs: args.runs, met: 0, failures: 0, answers: [] };
    for (let run = 0; run < args.runs; run++) {
      const before = telemetry.length;
      const verdict = await judge.review(testCase.input);
      // Telemetry is published before the verdict is parsed, so a malformed answer has it too.
      const actualModel = telemetry.length > before ? telemetry[telemetry.length - 1]!.actualModel : null;
      if (!verdict.ok) {
        result.failures += 1;
        result.answers.push({ ok: false, failure: verdict.failure });
        continue;
      }
      if (actualModel !== null && !sameModel(args.model, actualModel)) {
        result.failures += 1;
        result.answers.push({ ok: false, failure: `answered by ${actualModel}` });
        continue;
      }
      if (verdict.unsupportedClaims === undefined) {
        // Cannot happen while the cases ask grounding; if it ever does, never score it as clean.
        result.failures += 1;
        result.answers.push({ ok: false, failure: 'grounding not answered' });
        continue;
      }
      result.answers.push({
        ok: true,
        actualModel,
        unsupportedClaims: verdict.unsupportedClaims,
        unnecessaryItems: verdict.unnecessaryItems ?? [],
        purpose: verdict.purpose,
        speaksAsPrincipal: verdict.speaksAsPrincipal,
        stakes: verdict.stakes,
      });
      if (meetsLabel(testCase, verdict)) result.met += 1;
    }
    results.push(result);
  }

  const cost = telemetry.reduce((n, t) => n + t.estimatedCostUsd, 0);
  const summary = summarize(args.model, args.runs, results, cost);
  const pct = (c: LabelCount): string => c.rate === null ? 'n/a' : `${(c.rate * 100).toFixed(0)}% (${c.met}/${c.runs})`;
  process.stdout.write(
    `${args.model}: must-flag caught ${pct(summary.flag)}, must-pass sent ${pct(summary.pass)}, ` +
    `judge failures ${summary.failures}, estimated spend $${cost.toFixed(4)} (${args.runs} runs per case)\n`,
  );
  for (const r of results) {
    // For an observe case the count is how often the judge flagged it; it is in neither rate.
    const what = r.expect === 'observe' ? ' flagged' : '';
    process.stdout.write(`  ${r.expect.padEnd(7)} ${r.id.padEnd(32)} ${r.met}/${r.runs}${what}${r.failures ? ` (${r.failures} failures)` : ''}\n`);
  }
  if (args.jsonOut) writeFileSync(args.jsonOut, `${JSON.stringify(summary, null, 2)}\n`);
  return summary.failures > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => process.exit(code), (err: unknown) => {
    process.stderr.write(`FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

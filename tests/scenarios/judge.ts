// tests/scenarios/judge.ts — the LLM judge for behaviors without a `check`.
//
// Each run is judged on its own, and the judge sees what the model saw and did:
// the inbound, every tool call with its arguments and the result handed back, and
// the reply. Smoke's judge sees only the reply text, which is why it cannot score
// "delegated instead of answering". gpt-4o, as in smoke and curia-deploy's eval, so
// scores stay comparable across the three. With real delegation (#2027) it also sees
// each specialist's brief, its calls (labelled with its name) and its response.
import { ModelRegistry } from '../../src/agents/llm/model-registry.js';
import { createEstimateCostUsd } from '../../src/agents/llm/pricing.js';
import type { LLMProvider, LLMResponse } from '../../src/agents/llm/provider.js';
import { createLogger, type Logger } from '../../src/logger.js';
import type { UsageLedger } from '../shared/usage.js';
import { JUDGE_ERROR_PREFIX } from './gate.js';
import type { BehaviorRating, ExpectedBehavior, RunRating, ScenarioCase, ScenarioRun } from './types.js';

/** gpt-4o, as smoke and curia-deploy's eval use, reached through OpenRouter. */
export const JUDGE_MODEL = 'openai/gpt-4o';
const RATINGS: readonly BehaviorRating[] = ['PASS', 'PARTIAL', 'MISS'];

const SYSTEM_PROMPT = `You are grading one turn of an AI chief of staff (the "coordinator") against expected behaviors.

You see the inbound message, every tool call the coordinator made (arguments and the result it got back), and its final reply. "NO_REPLY" as the entire reply means it deliberately sent nothing.

Rate each behavior:
- PASS: clearly and fully demonstrated
- PARTIAL: attempted but incomplete or only partly correct
- MISS: not demonstrated, or contradicted

Judge only what is in the transcript. Tool calls count as actions taken; a tool result marked FAILED means that action did not happen.

When "Specialist runs" is present, the specialists the coordinator delegated to really ran: each run lists the brief the specialist received and the response it returned, and the specialist's own tool calls appear in the tool call list labelled with its name in brackets. Unlabelled calls are the coordinator's. The final reply is always the coordinator's.

Respond with ONLY a JSON object:
{"scores": [{"behaviorId": "<id>", "rating": "PASS|PARTIAL|MISS", "justification": "<one sentence>"}]}`;

export function formatJudgeInput(
  scenario: ScenarioCase,
  run: ScenarioRun,
  behaviors: ExpectedBehavior[],
  principalName?: string,
): string {
  const principal = principalName ? `the principal, ${principalName}` : 'the principal';
  const sender = scenario.inbound.from === 'principal'
    ? `${principal} (the executive the coordinator works for)`
    : scenario.inbound.from === 'bullpen'
      ? 'another internal agent, on the bullpen (internal agent-to-agent thread)'
      : scenario.inbound.from === 'scheduler'
        ? 'the scheduler: a recurring scheduled job firing, with no human sender'
        : (() => {
          const c = scenario.seed.contacts.find(x => x.key === scenario.inbound.from)!;
          return `${c.displayName}, an external contact (not ${principal}), via ${c.channel}`;
        })();

  const calls = run.toolCalls.length === 0
    ? '(no tool calls)'
    : run.toolCalls.map((c, i) => {
        const result = c.result === undefined
          ? '(no result recorded)'
          : c.result.success
            ? JSON.stringify(c.result.data, null, 2)
            : `FAILED: ${c.result.error}`;
        const who = c.agentId !== undefined && c.agentId !== 'coordinator' ? `[${c.agentId}] ` : '';
        return `${i + 1}. ${who}${c.name}\nArguments: ${JSON.stringify(c.input, null, 2)}\nResult: ${result}`;
      }).join('\n---\n');

  const specialists = run.delegations === undefined
    ? []
    : [
        ``,
        `## Specialist runs`,
        run.delegations.length === 0
          ? '(the coordinator started no specialist)'
          : run.delegations.map((d, i) => [
              `### ${i + 1}. ${d.agentId}`,
              `Brief received:`,
              d.brief,
              ``,
              d.outcome === 'in_flight'
                ? `Response: (none: still working when the run ended)`
                : `Response${d.outcome === 'error' ? ' (an error)' : ''}:\n${d.response ?? ''}`,
            ].join('\n')).join('\n\n'),
      ];

  return [
    `## Scenario`,
    scenario.description.trim() || scenario.name,
    ``,
    `## Sender`,
    sender,
    ``,
    `## Inbound message`,
    run.inboundContent,
    ``,
    `## Tool calls`,
    calls,
    ...specialists,
    ``,
    `## Final reply`,
    run.reply === null ? '(none)' : run.reply,
    ``,
    `## Expected behaviors`,
    behaviors.map(b => `- ${b.id}: ${b.description.trim()}`).join('\n'),
    ...(scenario.failureModes.length > 0
      ? [``, `## Known failure modes`, scenario.failureModes.map(f => `- ${f}`).join('\n')]
      : []),
    ``,
    `Rate each expected behavior. JSON only.`,
  ].join('\n');
}

/**
 * Parse the judge's reply into one rating per behavior. A behavior the judge skipped,
 * or an unparseable reply, scores MISS with a justification that says so — never a
 * silent drop, which would let a behavior vanish from the pass rate.
 */
export function parseJudgeResponse(raw: string, behaviors: ExpectedBehavior[]): Map<string, RunRating> {
  const out = new Map<string, RunRating>();
  let scores: Array<{ behaviorId?: unknown; rating?: unknown; justification?: unknown }> = [];
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(raw) as { scores?: unknown };
    if (!Array.isArray(parsed.scores)) throw new Error('missing scores array');
    scores = parsed.scores as typeof scores;
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }

  for (const b of behaviors) {
    const s = scores.find(x => x.behaviorId === b.id);
    if (!s) {
      // Prefixed JUDGE_ERROR_PREFIX: the judge failed, not the model — gate.ts reports it apart.
      out.set(b.id, { rating: 'MISS', justification: parseError ? `${JUDGE_ERROR_PREFIX}: reply unparseable: ${parseError}` : `${JUDGE_ERROR_PREFIX}: no score returned` });
      continue;
    }
    const rating = typeof s.rating === 'string' ? s.rating.trim().toUpperCase() : '';
    out.set(b.id, RATINGS.includes(rating as BehaviorRating)
      ? { rating: rating as BehaviorRating, justification: typeof s.justification === 'string' ? s.justification : '' }
      : { rating: 'MISS', justification: `${JUDGE_ERROR_PREFIX}: invalid rating '${String(s.rating)}'` });
  }
  return out;
}

export interface Judge {
  provider: LLMProvider;
  model: string;
  /** Named in the judge input so "never addresses the principal" is checkable. */
  principalName?: string;
  /**
   * Prices a judge response from the model registry (#1980). The judge publishes no
   * llm.call, so without this its spend would not appear in the run's cost.
   */
  estimateCostUsd?: (actualModel: string, usage: NonNullable<LLMResponse['usage']>) => number;
}

/**
 * Add one judge response's tokens and estimated cost to `usage`. Error responses count
 * too when the provider reports usage for them: a failed attempt can still be billed.
 */
export function meterJudgeResponse(judge: Judge, response: LLMResponse, usage: UsageLedger | undefined): void {
  if (!usage || !response.usage) return;
  const model = response.type === 'error' ? judge.model : response.provenance.actualModel;
  let cost = 0;
  try {
    cost = judge.estimateCostUsd?.(model, response.usage) ?? 0;
  } catch (err) {
    // Pricing must never abort judging (the call is already paid for). Say so, though:
    // a $0 here understates the run.
    process.stderr.write(`  [WARN] could not price a judge call on ${model}: ${err instanceof Error ? err.message : String(err)} — counted as $0\n`);
  }
  usage.addJudgeCall(response.usage, cost);
}

/** Transient judge failures worth another attempt; anything else would fail the same way every time. */
export const JUDGE_RETRYABLE: ReadonlySet<string> = new Set(['PROVIDER_ERROR', 'TIMEOUT', 'UNKNOWN', 'RATE_LIMIT']);

/**
 * Wait before judge attempt `attempt + 1`. A rate limit gets a longer wait: with cases
 * judged concurrently (#1980) a 429 is a burst, not a dead key, and waiting it out beats
 * failing every case behind it.
 */
export function judgeBackoffMs(errorType: string | undefined, attempt: number): number {
  return (errorType === 'RATE_LIMIT' ? 5_000 : 1_000) * attempt;
}

/**
 * The judge, called through the stack's own OpenRouter provider: the key stays in the
 * vault (#911), and the one OpenRouter credential serves both the model under test and
 * the judge. The provider passes no temperature or response_format through, so the
 * prompt asks for JSON and the reply is parsed leniently (a fenced block is unwrapped).
 */
export function createJudge(
  providers: ReadonlyMap<string, LLMProvider>,
  principalName?: string,
  options: { model?: string; logger?: Logger } = {},
): Judge {
  const model = options.model ?? JUDGE_MODEL;
  const provider = providers.get('openrouter');
  if (!provider) {
    throw new Error(
      `The judge (${model}) runs through OpenRouter, and the vault has no openrouter_api_key. ` +
      'Seed it (see tests/scenarios/README.md).',
    );
  }
  const logger = options.logger ?? createLogger('error');
  const registry = new ModelRegistry(logger);
  // An exact entry, not a prefix match: 'openai/gpt-4o-mini' would otherwise be priced as
  // 'openai/gpt-4o', and a model with no entry at all would throw on its first response —
  // after paying for it. Fail here instead, before any call (#1980).
  if (!Object.hasOwn(registry.getAllModels(), model)) {
    throw new Error(
      `The judge model '${model}' has no entry in src/agents/llm/model-registry.ts, so its spend cannot be priced. ` +
      'Add it (with its OpenRouter pricing) first.',
    );
  }
  const estimate = createEstimateCostUsd(registry, model);
  return {
    provider,
    model,
    ...(principalName ? { principalName } : {}),
    estimateCostUsd: (actual: string, usage: NonNullable<LLMResponse['usage']>) => estimate(actual, usage, logger),
  };
}

/** A JSON object out of a model reply that may wrap it in a code fence or prose. */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

const JUDGE_ATTEMPTS = 3;

/**
 * Judge one run's prose behaviors.
 *
 * - Auth, not-found (judge model retired) and validation errors throw: they would
 *   repeat on every run, and an all-MISS suite would read as a broken coordinator.
 * - Transient errors (rate limits included) are retried, then score the run's judged
 *   behaviors MISS with a JUDGE_ERROR_PREFIX justification, which the gate reports as a
 *   judge failure.
 *
 * Each attempt's tokens and estimated cost go to `usage` when given.
 */
export async function judgeRun(
  scenario: ScenarioCase,
  run: ScenarioRun,
  behaviors: ExpectedBehavior[],
  judge: Judge,
  usage?: UsageLedger,
): Promise<Map<string, RunRating>> {
  if (behaviors.length === 0) return new Map();

  let lastError = '';
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
    const response = await judge.provider.chat({
      model: judge.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: formatJudgeInput(scenario, run, behaviors, judge.principalName) },
      ],
    });
    meterJudgeResponse(judge, response, usage);

    if (response.type === 'text') {
      return parseJudgeResponse(extractJsonObject(response.content), behaviors);
    }
    if (response.type === 'tool_use') {
      lastError = 'answered with a tool call, not JSON';
      continue;
    }
    const { type, message } = response.error;
    if (!JUDGE_RETRYABLE.has(type)) {
      throw new Error(`Judge call failed (${type}): ${message}`);
    }
    lastError = `${type}: ${message}`;
    await new Promise(resolve => setTimeout(resolve, judgeBackoffMs(type, attempt)));
  }
  return new Map(behaviors.map(b => [b.id, {
    rating: 'MISS' as const,
    justification: `${JUDGE_ERROR_PREFIX} after ${JUDGE_ATTEMPTS} attempts — ${lastError}`,
  }]));
}

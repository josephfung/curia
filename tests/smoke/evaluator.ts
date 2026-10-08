// tests/smoke/evaluator.ts
//
// The judge: gpt-4o, reached through the stack's own OpenRouter provider (the same
// judge as the scenario suite — tests/scenarios/judge.ts), so the key stays in the
// vault (#911) and no OPENAI_API_KEY is needed.
import type { Judge } from '../scenarios/judge.js';
import { extractJsonObject, judgeBackoffMs, JUDGE_RETRYABLE, meterJudgeResponse } from '../scenarios/judge.js';
import { runConcurrently } from '../shared/case-scope.js';
import { sumBreakdowns, UsageLedger } from '../shared/usage.js';
import { caseFailures } from './gate.js';
import type {
  CaseExecution,
  CaseResult,
  BehaviorScore,
  BehaviorRating,
  ExpectedBehavior,
} from './types.js';
import { WEIGHT_VALUES, RATING_VALUES } from './types.js';

const RATINGS: readonly BehaviorRating[] = ['PASS', 'PARTIAL', 'MISS'];

const JUDGE_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are evaluating an AI executive assistant's conversation against expected behaviors.

Rate each behavior as:
- PASS: clearly and correctly demonstrated
- PARTIAL: attempted but incomplete, imprecise, or only partly correct
- MISS: not demonstrated at all, or contradicted

"NO_REPLY" as an entire response means the assistant deliberately sent nothing. When tool calls are shown, they are actions the assistant took; a result marked FAILED means that action did not happen.

Respond with ONLY a JSON object in this exact format:
{
  "scores": [
    { "behaviorId": "<id>", "rating": "PASS|PARTIAL|MISS", "justification": "<brief reason>" }
  ]
}`;

/**
 * Judge every case, `concurrency` at a time (default 1); results keep the input order.
 * Cases that did not complete are not judged: every behavior scores MISS and the gate
 * reports the execution error instead. Each result's `usage` is its execution's plus the
 * judge's own calls.
 */
export async function evaluateCases(
  executions: CaseExecution[],
  judge: Judge,
  options?: {
    onCaseEval?: (name: string, index: number, total: number) => void;
    /** "Today" as the agents saw it, so the judge can check relative dates. */
    today?: string;
    concurrency?: number;
  },
): Promise<CaseResult[]> {
  let started = 0;
  return runConcurrently(executions, options?.concurrency ?? 1, async (exec) => {
    options?.onCaseEval?.(exec.testCase.name, ++started, executions.length);

    let scores: BehaviorScore[];
    let judgeError: string | undefined;
    const judgeUsage = new UsageLedger();
    if (exec.error) {
      scores = exec.testCase.expectedBehaviors.map(b => ({
        behaviorId: b.id,
        rating: 'MISS' as BehaviorRating,
        justification: `Case execution failed: ${exec.error}`,
      }));
    } else {
      ({ scores, error: judgeError } = await judgeCase(exec, judge, options?.today, judgeUsage));
    }

    const weightedScore = exec.error ? 0 : computeWeightedScore(exec.testCase.expectedBehaviors, scores);
    const gateInput = {
      testCase: exec.testCase,
      scores,
      weightedScore,
      ...(exec.error ? { error: exec.error } : {}),
      ...(judgeError ? { judgeError } : {}),
    };
    const failures = caseFailures(gateInput);
    const result: CaseResult = {
      ...gateInput,
      ...(exec.target ? { target: exec.target } : {}),
      responses: exec.responses,
      agentCalls: exec.agentCalls,
      passed: failures.length === 0,
      failures,
      usage: sumBreakdowns([exec.usage, judgeUsage.snapshot()]),
      providerRetries: exec.providerRetries,
    };
    return result;
  });
}

/** The transcript the judge reads: each turn's message, optionally its tool calls, and the reply. */
export function formatJudgeInput(exec: CaseExecution, principalName?: string, today?: string): string {
  const tc = exec.testCase;
  const principal = principalName ? `the principal, ${principalName}` : 'the principal';
  // A targeted case is judged against its agent, not the coordinator: "drafts a reply"
  // means that agent drafted it. The resolved target is the one the agent saw.
  const target = exec.target ?? tc.target;
  const agent = target?.agent ?? 'coordinator';
  const sender = target
    ? `the ${target.from} agent, posting on the bullpen thread below and mentioning ${target.agent}`
    : tc.sender === 'unknown'
      ? `an unknown external sender by email (no contact record, not ${principal})`
      : `${principal} (the executive the assistant works for)`;

  const turns = tc.turns.map((turn, i) => {
    const response = exec.responses[i];
    // What was actually sent: the turn with its date placeholders resolved.
    const lines = [`### Turn ${i + 1}`, `Message:`, (response?.prompt ?? turn.content).trim(), ``];
    if (tc.judgeToolCalls) {
      lines.push(target ? `${agent}'s tool calls:` : `Tool calls:`, formatToolCalls(response?.toolCalls ?? []), ``);
    }
    lines.push(target ? `${agent}'s response:` : `Assistant response:`, response ? response.content : '(none)');
    if (response?.noReplyReason) {
      lines.push(`(Delivery was suppressed — ${response.noReplyReason}. The sender did not receive this.)`);
    }
    return lines.join('\n');
  });

  // The judged agent's calls are shown per turn above; what it delegated happened in the
  // specialists' own turns. Without these, "created the event on the principal's calendar"
  // or "took no action for the stranger" would be judged from the coordinator's prose alone.
  const specialistCalls = tc.judgeToolCalls ? exec.agentCalls.filter(c => c.agentId !== agent) : [];

  return [
    `## Scenario`,
    tc.description.trim() || tc.name,
    ``,
    // Without it the judge grades dates against its own training-era "now" and marks a
    // correct "next Tuesday" wrong.
    ...(today ? [`## Today`, today, ``] : []),
    ...(target
      ? [
          `## Agent under test`,
          `${target.agent}: a specialist agent, not the coordinator the principal talks to. ` +
            `Judge every behavior against what ${target.agent} did. Its tool calls are its actions; ` +
            `its response is the report it ends its turn with, which goes to no person.`,
          ``,
          `## Bullpen thread`,
          `Topic: ${target.topic}`,
          `${target.agent} opened it with:`,
          target.opening.trim(),
          ``,
        ]
      : []),
    `## Sender`,
    sender,
    ``,
    `## Conversation`,
    turns.join('\n\n'),
    ``,
    ...(tc.judgeToolCalls
      ? [
          target ? `## Other agents' tool calls` : `## Specialists' tool calls (work the assistant delegated)`,
          specialistCalls.length === 0
            ? '(none)'
            : specialistCalls.map((c, i) => {
                const outcome = c.success === undefined ? 'no result' : c.success ? 'ok' : 'FAILED';
                return `${i + 1}. ${c.agentId ?? 'unknown agent'} → ${c.toolName} ${JSON.stringify(c.input)} [${outcome}]`;
              }).join('\n'),
          ``,
        ]
      : []),
    `## Expected Behaviors`,
    tc.expectedBehaviors.map(b => `- ${b.id}: ${b.description.trim()} [${b.weight}]`).join('\n'),
    ...(tc.failureModes.length > 0
      ? [``, `## Known Failure Modes`, tc.failureModes.map(f => `- ${f}`).join('\n')]
      : []),
    ``,
    `Rate each behavior. Respond with JSON only.`,
  ].join('\n');
}

function formatToolCalls(calls: CaseExecution['responses'][number]['toolCalls']): string {
  if (calls.length === 0) return '(no tool calls)';
  return calls.map((c, i) => {
    const result = c.result === undefined
      ? '(no result recorded)'
      : c.result.success
        ? JSON.stringify(c.result.data)
        : `FAILED: ${c.result.error}`;
    return `${i + 1}. ${c.name} ${JSON.stringify(c.input)}\n   Result: ${result}`;
  }).join('\n');
}

/**
 * Judge one case.
 * - Auth, not-found (judge model retired) and validation errors throw: they would repeat
 *   on every case, and an all-MISS run would read as a broken Curia.
 * - Transient errors (rate limits included) are retried, then reported as the case's
 *   judge error.
 * Every attempt's spend goes to `usage`.
 */
async function judgeCase(
  exec: CaseExecution,
  judge: Judge,
  today: string | undefined,
  usage: UsageLedger,
): Promise<{ scores: BehaviorScore[]; error?: string }> {
  let lastError = '';
  for (let attempt = 1; attempt <= JUDGE_ATTEMPTS; attempt++) {
    let response: Awaited<ReturnType<Judge['provider']['chat']>>;
    try {
      response = await judge.provider.chat({
        model: judge.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: formatJudgeInput(exec, judge.principalName, today) },
        ],
      });
    } catch (err) {
      // A provider that throws (network reset, SDK bug) rather than returning an error
      // result is treated as transient, not allowed to abort the run and lose every result.
      lastError = `provider threw: ${err instanceof Error ? err.message : String(err)}`;
      await new Promise(resolve => setTimeout(resolve, judgeBackoffMs(undefined, attempt)));
      continue;
    }
    meterJudgeResponse(judge, response, usage);

    if (response.type === 'text') {
      return parseJudgeResponse(extractJsonObject(response.content), exec.testCase.expectedBehaviors);
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
  return {
    scores: exec.testCase.expectedBehaviors.map(b => ({
      behaviorId: b.id,
      rating: 'MISS' as BehaviorRating,
      justification: `Judge failed after ${JUDGE_ATTEMPTS} attempts: ${lastError}`,
    })),
    error: `failed after ${JUDGE_ATTEMPTS} attempts — ${lastError}`,
  };
}

/**
 * Parse the judge's JSON reply into one score per expected behavior.
 *
 * Anything the judge got wrong — an unparseable reply, a behavior it skipped, an
 * invalid rating — scores that behavior MISS and is returned as `error`, so the gate
 * reports a judge failure rather than blaming the model. IDs the judge invented are
 * ignored with a warning (they usually come paired with a skipped one, which errors).
 */
export function parseJudgeResponse(
  raw: string,
  behaviors: ExpectedBehavior[],
): { scores: BehaviorScore[]; error?: string } {
  let returned: Array<{ behaviorId?: unknown; rating?: unknown; justification?: unknown }>;
  try {
    const parsed = JSON.parse(raw) as { scores?: unknown };
    if (!Array.isArray(parsed.scores)) throw new Error('missing scores array');
    // Drop entries that aren't objects ({"scores": [null]}); their behaviors then count as
    // skipped — a judge error — instead of crashing the run.
    returned = (parsed.scores as unknown[]).filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      scores: behaviors.map(b => ({
        behaviorId: b.id,
        rating: 'MISS' as BehaviorRating,
        justification: `Failed to parse judge response: ${detail}`,
      })),
      error: `unparseable reply: ${detail}`,
    };
  }

  const expectedIds = new Set(behaviors.map(b => b.id));
  for (const s of returned) {
    if (typeof s.behaviorId === 'string' && !expectedIds.has(s.behaviorId)) {
      process.stderr.write(`  [WARN] Judge returned unexpected behavior ID '${s.behaviorId}' — ignored\n`);
    }
  }

  const problems: string[] = [];
  const scores = behaviors.map((b): BehaviorScore => {
    const s = returned.find(x => x.behaviorId === b.id);
    if (!s) {
      problems.push(`no score for '${b.id}'`);
      return { behaviorId: b.id, rating: 'MISS', justification: 'Judge returned no score for this behavior' };
    }
    const rating = typeof s.rating === 'string' ? s.rating.trim().toUpperCase() : '';
    if (!RATINGS.includes(rating as BehaviorRating)) {
      problems.push(`invalid rating '${String(s.rating)}' for '${b.id}'`);
      return { behaviorId: b.id, rating: 'MISS', justification: `Judge returned an invalid rating '${String(s.rating)}'` };
    }
    return {
      behaviorId: b.id,
      rating: rating as BehaviorRating,
      justification: typeof s.justification === 'string' ? s.justification : '',
    };
  });

  return problems.length > 0 ? { scores, error: problems.join('; ') } : { scores };
}

/**
 * Compute weighted score for a case. Returns 0-1 where 1.0 = all PASS.
 * Uses WEIGHT_VALUES (critical=3, important=2, nice-to-have=1) and
 * RATING_VALUES (PASS=1.0, PARTIAL=0.5, MISS=0.0).
 */
export function computeWeightedScore(
  behaviors: ExpectedBehavior[],
  scores: BehaviorScore[],
): number {
  // Build a lookup from behaviorId → score for O(1) access
  const scoreMap = new Map(scores.map(s => [s.behaviorId, s]));
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const b of behaviors) {
    const w = WEIGHT_VALUES[b.weight];
    totalWeight += w;
    const score = scoreMap.get(b.id);
    if (score) {
      earnedWeight += w * RATING_VALUES[score.rating];
    } else {
      // Backstop warn: parseJudgeResponse scores every expected behavior, so this only
      // fires for a caller that built scores some other way. Counts as 0.
      process.stderr.write(
        `  [WARN] No score entry for behavior '${b.id}' — counting as 0\n`,
      );
    }
  }

  // Guard against degenerate empty-behaviors case
  return totalWeight === 0 ? 0 : earnedWeight / totalWeight;
}

// tests/scenarios/judge.ts — the LLM judge for behaviors without a `check`.
//
// Each run is judged on its own, and the judge sees what the model saw and did:
// the inbound, every tool call with its arguments and the result handed back, and
// the reply. Smoke's judge sees only the reply text, which is why it cannot score
// "delegated instead of answering". gpt-4o, as in smoke and curia-deploy's eval, so
// scores stay comparable across the three.
import type { BehaviorRating, ExpectedBehavior, RunRating, ScenarioCase, ScenarioRun } from './types.js';

export const JUDGE_MODEL = 'gpt-4o';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const RATINGS: readonly BehaviorRating[] = ['PASS', 'PARTIAL', 'MISS'];

const SYSTEM_PROMPT = `You are grading one turn of an AI chief of staff (the "coordinator") against expected behaviors.

You see the inbound message, every tool call the coordinator made (arguments and the result it got back), and its final reply. "NO_REPLY" as the entire reply means it deliberately sent nothing.

Rate each behavior:
- PASS: clearly and fully demonstrated
- PARTIAL: attempted but incomplete or only partly correct
- MISS: not demonstrated, or contradicted

Judge only what is in the transcript. Tool calls count as actions taken; a tool result marked FAILED means that action did not happen.

Respond with ONLY a JSON object:
{"scores": [{"behaviorId": "<id>", "rating": "PASS|PARTIAL|MISS", "justification": "<one sentence>"}]}`;

export function formatJudgeInput(scenario: ScenarioCase, run: ScenarioRun, behaviors: ExpectedBehavior[]): string {
  const sender = scenario.inbound.from === 'principal'
    ? 'the principal (the executive the coordinator works for)'
    : scenario.inbound.from === 'bullpen'
      ? 'another internal agent, on the bullpen (internal agent-to-agent thread)'
      : (() => {
          const c = scenario.seed.contacts.find(x => x.key === scenario.inbound.from)!;
          return `${c.displayName}, an external contact (not the principal), via ${c.channel}`;
        })();

  const calls = run.toolCalls.length === 0
    ? '(no tool calls)'
    : run.toolCalls.map((c, i) => {
        const result = c.result === undefined
          ? '(no result recorded)'
          : c.result.success
            ? JSON.stringify(c.result.data, null, 2)
            : `FAILED: ${c.result.error}`;
        return `${i + 1}. ${c.name}\nArguments: ${JSON.stringify(c.input, null, 2)}\nResult: ${result}`;
      }).join('\n---\n');

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
      out.set(b.id, { rating: 'MISS', justification: parseError ? `judge reply unparseable: ${parseError}` : 'judge returned no score' });
      continue;
    }
    const rating = typeof s.rating === 'string' ? s.rating.trim().toUpperCase() : '';
    out.set(b.id, RATINGS.includes(rating as BehaviorRating)
      ? { rating: rating as BehaviorRating, justification: typeof s.justification === 'string' ? s.justification : '' }
      : { rating: 'MISS', justification: `judge gave an invalid rating '${String(s.rating)}'` });
  }
  return out;
}

/** Judge one run's prose behaviors. Auth and rate-limit failures throw: they would repeat for every run. */
export async function judgeRun(
  scenario: ScenarioCase,
  run: ScenarioRun,
  behaviors: ExpectedBehavior[],
  apiKey: string,
): Promise<Map<string, RunRating>> {
  if (behaviors.length === 0) return new Map();

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: formatJudgeInput(scenario, run, behaviors) },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Judge authentication failed (${response.status}) — check OPENAI_API_KEY`);
  }
  if (response.status === 429) {
    throw new Error('Judge rate limited (429) — wait and re-run');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    const message = `judge API error ${response.status}: ${body.slice(0, 200)}`;
    return new Map(behaviors.map(b => [b.id, { rating: 'MISS' as const, justification: message }]));
  }

  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return parseJudgeResponse(json.choices?.[0]?.message?.content ?? '', behaviors);
}

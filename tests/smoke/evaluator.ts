// tests/smoke/evaluator.ts
import type {
  CaseExecution,
  CaseResult,
  BehaviorScore,
  BehaviorRating,
  ExpectedBehavior,
} from './types.js';
import { WEIGHT_VALUES, RATING_VALUES } from './types.js';

const JUDGE_MODEL = 'gpt-4o';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Evaluate all case executions using GPT-4o as a judge.
 * Processes cases sequentially to avoid hammering the OpenAI API.
 */
export async function evaluateCases(
  executions: CaseExecution[],
  apiKey: string,
  options?: { onCaseEval?: (name: string, index: number, total: number) => void },
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  for (let i = 0; i < executions.length; i++) {
    const exec = executions[i]!;
    options?.onCaseEval?.(exec.testCase.name, i + 1, executions.length);

    // If the case failed to execute, skip judging and mark all behaviors MISS
    if (exec.error) {
      const scores: BehaviorScore[] = exec.testCase.expectedBehaviors.map(b => ({
        behaviorId: b.id,
        rating: 'MISS' as BehaviorRating,
        justification: `Case execution failed: ${exec.error}`,
      }));
      results.push({
        testCase: exec.testCase,
        responses: exec.responses,
        scores,
        weightedScore: 0,
        error: exec.error,
      });
      continue;
    }

    const scores = await judgeCase(exec, apiKey);
    const weightedScore = computeWeightedScore(exec.testCase.expectedBehaviors, scores);

    results.push({
      testCase: exec.testCase,
      responses: exec.responses,
      scores,
      weightedScore,
    });
  }

  return results;
}

/**
 * Send a single case to GPT-4o for evaluation.
 * Falls back to all-MISS on any API or network error so the run continues.
 */
async function judgeCase(exec: CaseExecution, apiKey: string): Promise<BehaviorScore[]> {
  // Concatenate all turns and responses so the judge sees the full conversation
  const userPrompts = exec.testCase.turns.map(t => t.content).join('\n---\n');
  const assistantResponses = exec.responses.map(r => r.content).join('\n---\n');
  const behaviorsText = exec.testCase.expectedBehaviors
    .map(b => `- ${b.id}: ${b.description} [${b.weight}]`)
    .join('\n');

  const systemPrompt = `You are evaluating an AI assistant's response against expected behaviors.

Rate each behavior as:
- PASS: clearly and correctly demonstrated
- PARTIAL: attempted but incomplete, imprecise, or only partly correct
- MISS: not demonstrated at all

Respond with ONLY a JSON object in this exact format:
{
  "scores": [
    { "behaviorId": "<id>", "rating": "PASS|PARTIAL|MISS", "justification": "<brief reason>" }
  ]
}`;

  const userMessage = `## User Input
${userPrompts}

## Assistant Response
${assistantResponses}

## Expected Behaviors
${behaviorsText}

Rate each behavior. Respond with JSON only.`;

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        // Low temperature for deterministic scoring
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new Error(`Judge API error ${response.status}: ${body}`);
    }

    const json = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = json.choices[0]?.message?.content ?? '';
    return parseJudgeResponse(content, exec.testCase.expectedBehaviors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Systemic errors should abort — falling back to all-MISS would produce
    // a garbage run that's indistinguishable from "Curia is broken."
    if (message.includes('401') || message.includes('403')) {
      throw new Error(`Judge API authentication failed — check OPENAI_API_KEY: ${message}`);
    }
    if (message.includes('429')) {
      throw new Error(`Judge API rate limited — wait and retry: ${message}`);
    }

    // Per-case failure: fall back to MISS but warn the operator
    process.stderr.write(`  [WARN] Judge failed for "${exec.testCase.name}": ${message}\n`);

    return exec.testCase.expectedBehaviors.map(b => ({
      behaviorId: b.id,
      rating: 'MISS' as BehaviorRating,
      justification: `Judge error: ${message}`,
    }));
  }
}

/**
 * Parse the judge's JSON response into BehaviorScore[].
 * Falls back to all-MISS (using fallbackBehaviors) if parsing fails.
 * If fallbackBehaviors is omitted and parsing fails, returns an empty array.
 */
export function parseJudgeResponse(
  raw: string,
  fallbackBehaviors?: ExpectedBehavior[],
): BehaviorScore[] {
  try {
    const parsed = JSON.parse(raw) as { scores: BehaviorScore[] };
    if (!Array.isArray(parsed.scores)) throw new Error('Missing scores array');

    // Normalize any unrecognized rating values to MISS for safety
    return parsed.scores.map(s => ({
      behaviorId: s.behaviorId,
      rating: (['PASS', 'PARTIAL', 'MISS'].includes(s.rating) ? s.rating : 'MISS') as BehaviorRating,
      justification: s.justification ?? '',
    }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!fallbackBehaviors) return [];
    return fallbackBehaviors.map(b => ({
      behaviorId: b.id,
      rating: 'MISS' as BehaviorRating,
      justification: `Failed to parse judge response: ${detail}`,
    }));
  }
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
    }
    // If a behavior has no corresponding score entry, it counts as 0 earned weight
  }

  // Guard against degenerate empty-behaviors case
  return totalWeight === 0 ? 0 : earnedWeight / totalWeight;
}

// tests/scenarios/blind-id.ts — can a reader tell who each message was written for? (#2556)
//
// A contrast group links the cases of one task that differ only in the recipient (a board
// chair, a direct report, a friend...). After the cases run, this post-pass takes one run's
// message from each case, shuffles them, and asks the judge to match each message to a
// recipient description. If the judge cannot tell which message went to whom, Curia is not
// writing differently for different people, however well each message scores on its own.
//
// Each trial is asked twice, the messages in a seeded shuffle and then reversed, so a judge's
// lean towards an order cancels out. The result is accuracy per group against chance. It is
// tracked, not gated: a group's accuracy is a measure for the baseline report, not a pass bar.
//
// Recipient descriptions say who the person is to the principal, never their name or the
// situation: the messages name people, and a description that shares a name or a detail of
// the situation would let the judge match on that instead of on voice.
import type { LLMResponse } from '../../src/agents/llm/provider.js';
import type { UsageLedger } from '../shared/usage.js';
import { containsSubset } from './assertions.js';
import { extractJsonObject, JUDGE_RETRYABLE, judgeBackoffMs, meterJudgeResponse, type Judge } from './judge.js';
import { resolveRunPlaceholders } from './loader.js';
import type { CaseResult, ContrastGroupResult, ContrastMessageSource, ScenarioCase, ScenarioRun } from './types.js';

/**
 * The message a run wrote for its recipient: the last call matching any source (its `with`
 * resolved against the run's refs), else the reply when `reply` is a source. Undefined when
 * the run wrote none: a decision not to write is not a voice to identify.
 */
export function contrastMessage(sources: readonly ContrastMessageSource[], run: ScenarioRun): string | undefined {
  if (run.error) return undefined;
  const resolved = resolveRunPlaceholders([...sources], run);
  let found: string | undefined;
  for (const call of run.toolCalls) {
    for (const source of resolved) {
      if (source === 'reply' || call.name !== source.tool) continue;
      if (source.with && !containsSubset(source.with, call.input)) continue;
      const value = call.input[source.arg];
      if (typeof value === 'string' && value.trim() !== '') found = value;
    }
  }
  if (found !== undefined) return found;
  const silent = run.reply === null || run.reply.trim() === '' || run.reply.trim() === 'NO_REPLY';
  return resolved.includes('reply') && !silent ? run.reply! : undefined;
}

/** A deterministic shuffle (mulberry32 seeded from `seed`), so a group's trials repeat exactly. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = h >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const BLIND_ID_SYSTEM_PROMPT = `You are checking whether an executive assistant writes differently for different people.

The assistant works for one executive. You get descriptions of several people in the executive's life, each labelled with a letter, and the same number of messages, each numbered. Each message was written by the assistant for exactly one of the people described, about a similar situation. Every person has exactly one message.

Match each message to the person it was written for, from its tone, register, warmth, length and what it chooses to say. Names in the messages are not in the descriptions, so they will not help you. Use each letter exactly once.

Respond with ONLY a JSON object:
{"matches": [{"message": 1, "recipient": "A"}, ...]}`;

/** The judge's input for one ordering: recipients by letter, then the messages in `order`. */
export function formatBlindIdInput(recipients: readonly string[], messages: readonly string[]): string {
  return [
    '## The people',
    ...recipients.map((r, i) => `${LETTERS[i]}. ${r.trim()}`),
    '',
    '## The messages',
    ...messages.flatMap((m, i) => [`### Message ${i + 1}`, m.trim(), '']),
    'Match every message to one person. JSON only.',
  ].join('\n');
}

/**
 * The judge's letter for each message number (1-based) of an `n`-message trial, or why the
 * reply is not a usable answer. Only a complete one-to-one answer is scored: messages 1..n
 * each once, letters A.. each once. Anything else (a short list, 0-based numbers, a repeated
 * or unknown letter, "Person A") is the judge failing at the task, not Curia writing alike,
 * so it is an error and counts in neither correct nor total.
 */
export function parseBlindIdResponse(raw: string, n: number): { matches: Map<number, string> } | { error: string } {
  let parsed: { matches?: unknown };
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as { matches?: unknown };
  } catch (e) {
    return { error: `unparseable reply: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!Array.isArray(parsed.matches)) return { error: 'reply has no matches array' };
  const letters = new Set(LETTERS.slice(0, n).split(''));
  const matches = new Map<number, string>();
  for (const m of parsed.matches as Array<{ message?: unknown; recipient?: unknown }>) {
    const num = typeof m.message === 'number' ? m.message : Number(m.message);
    const letter = typeof m.recipient === 'string' ? m.recipient.trim().toUpperCase() : '';
    if (!Number.isInteger(num) || num < 1 || num > n) return { error: `message number '${String(m.message)}' is not 1..${n}` };
    if (!letters.has(letter)) return { error: `recipient '${String(m.recipient)}' is not one of ${[...letters].join(', ')}` };
    if (matches.has(num)) return { error: `message ${num} matched twice` };
    matches.set(num, letter);
  }
  if (matches.size !== n) return { error: `matched ${matches.size} of ${n} messages` };
  if (new Set(matches.values()).size !== n) return { error: 'a recipient letter was used more than once' };
  return { matches };
}

/** One trial: the group's messages from one run index, by case. */
export interface BlindIdTrial {
  runIndex: number;
  /** Case name → its message, for the cases that wrote one at this run index. */
  messages: Map<string, string>;
}

/** The trials a group's results allow: one per run index, skipping those with under two messages. */
export function collectTrials(
  members: ReadonlyArray<{ scenario: ScenarioCase; result: CaseResult }>,
): { trials: BlindIdTrial[]; skipped: number } {
  const runCount = Math.max(0, ...members.map(m => m.result.runs.length));
  const trials: BlindIdTrial[] = [];
  let skipped = 0;
  for (let i = 0; i < runCount; i++) {
    const messages = new Map<string, string>();
    for (const { scenario, result } of members) {
      const run = result.runs[i];
      const text = run ? contrastMessage(scenario.contrast!.message, run) : undefined;
      if (text !== undefined) messages.set(scenario.name, text);
    }
    if (messages.size >= 2) trials.push({ runIndex: i, messages });
    else skipped++;
  }
  return { trials, skipped };
}

const ATTEMPTS = 3;

/** Ask the judge once; null when it failed after retries. */
async function askJudge(judge: Judge, input: string, usage: UsageLedger | undefined): Promise<string | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const response: LLMResponse = await judge.provider.chat({
      model: judge.model,
      messages: [{ role: 'system', content: BLIND_ID_SYSTEM_PROMPT }, { role: 'user', content: input }],
    });
    meterJudgeResponse(judge, response, usage);
    if (response.type === 'text') return response.content;
    if (response.type === 'tool_use') continue;
    if (!JUDGE_RETRYABLE.has(response.error.type)) {
      throw new Error(`Blind-identification judge call failed (${response.error.type}): ${response.error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, judgeBackoffMs(response.error.type, attempt)));
  }
  return null;
}

/** Run the check for one group over the cases this run included. */
export async function runBlindId(
  group: string,
  members: ReadonlyArray<{ scenario: ScenarioCase; result: CaseResult }>,
  missing: string[],
  judge: Judge,
  usage?: UsageLedger,
): Promise<ContrastGroupResult> {
  const ordered = [...members].sort((a, b) => a.scenario.name.localeCompare(b.scenario.name));
  const { trials, skipped } = collectTrials(ordered);
  const byCase: Record<string, { correct: number; total: number }> = Object.fromEntries(ordered.map(m => [m.scenario.name, { correct: 0, total: 0 }]));
  let correct = 0;
  let total = 0;
  let calls = 0;
  let judgeErrors = 0;
  let firstJudgeError: string | undefined;
  let chanceSum = 0;
  let asked = 0;

  for (const trial of trials) {
    // Only the people whose messages are in this trial: an extra description would be a
    // decoy, and a one-to-one match is what the chance figure assumes.
    const present = ordered.filter(m => trial.messages.has(m.scenario.name));
    const recipients = present.map(m => m.scenario.contrast!.recipient);
    const letters = new Map(present.map((m, i) => [m.scenario.name, LETTERS[i]!]));
    const shuffled = seededShuffle(present.map(m => m.scenario.name), `${group}#${trial.runIndex}`);
    for (const order of [shuffled, [...shuffled].reverse()]) {
      calls++;
      let answer: ReturnType<typeof parseBlindIdResponse>;
      try {
        const raw = await askJudge(judge, formatBlindIdInput(recipients, order.map(name => trial.messages.get(name)!)), usage);
        answer = raw === null ? { error: 'failed after retries' } : parseBlindIdResponse(raw, present.length);
      } catch (e) {
        // A non-retryable error on one trial (a content filter, an over-long input) loses that
        // trial, not the group's: the trials already paid for still count.
        answer = { error: e instanceof Error ? e.message : String(e) };
      }
      if ('error' in answer) {
        // The judge failing is not Curia failing: the call counts in neither correct nor
        // total, and judgeErrors (with the first reason) says how much went unmeasured.
        judgeErrors++;
        firstJudgeError ??= answer.error;
        continue;
      }
      order.forEach((name, i) => {
        const right = answer.matches.get(i + 1) === letters.get(name);
        byCase[name]!.total++;
        if (right) byCase[name]!.correct++;
        total++;
        if (right) correct++;
      });
      chanceSum += 1 / present.length;
      asked++;
    }
  }
  return {
    group,
    cases: ordered.map(m => m.scenario.name),
    missing,
    judgeCalls: calls,
    correct,
    total,
    accuracy: total === 0 ? null : correct / total,
    chance: asked === 0 ? null : chanceSum / asked,
    byCase,
    skippedTrials: skipped,
    judgeErrors,
    ...(firstJudgeError !== undefined ? { firstJudgeError } : {}),
  };
}

/**
 * "finesse-51-reschedule: 7/12 matched (58%; chance 33%)", then each case's hits. A case with
 * no message in any trial is named: its source may match nothing, and the group's chance figure
 * is then over fewer recipients than it has.
 */
export function formatBlindIdLines(results: readonly ContrastGroupResult[]): string[] {
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  return results.flatMap(r => {
    const notes = [
      ...(r.missing.length > 0 ? [`not in this run: ${r.missing.join(', ')}`] : []),
      ...(r.skippedTrials > 0 ? [`${r.skippedTrials} trial(s) skipped, under two messages`] : []),
      ...(r.judgeErrors > 0 ? [`${r.judgeErrors} judge error(s), first: ${r.firstJudgeError ?? '(no reason)'}`] : []),
    ];
    const head = r.accuracy === null
      ? `${r.group}: not measured`
      : `${r.group}: ${r.correct}/${r.total} matched (${pct(r.accuracy)}; chance ${pct(r.chance!)})`;
    const lines = [`${head}${notes.length > 0 ? `; ${notes.join('; ')}` : ''}`];
    for (const [name, c] of Object.entries(r.byCase)) {
      lines.push(c.total > 0 ? `  ${name}: ${c.correct}/${c.total}` : `  ${name}: no message in any trial (check its contrast.message source)`);
    }
    return lines;
  });
}

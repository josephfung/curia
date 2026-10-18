// tests/scenarios/assertions.ts — behaviors scored in code, not by the judge.
//
// When the behavior under test IS a tool call ("delegates to ceo-inbox", "never calls
// email-reply"), asking an LLM whether it happened adds noise and nothing else. These
// checks read the captured calls and reply directly. A refused call still counts as a
// call: the model chose to make it, and that choice is what is being tested. A `called`
// check may set `success` when the behavior is the effect, not the attempt.
//
// A run with real delegation (#2027) holds every agent's calls. A tool check reads the
// case agent's (the coordinator's unless the case targets a specialist, #2025) unless it
// names an `agent` (or `any`).
import { isDeepStrictEqual } from 'node:util';
import { argsMatch } from './stub-matcher.js';
import { ANY_AGENT, COORDINATOR, type BehaviorCheck, type CapturedToolCall, type CheckAgent, type RunRating, type ScenarioRun } from './types.js';

/**
 * The calls a check reads: the case agent's by default. A call without agentId was saved
 * before #2027, when every recorded call was the coordinator's.
 */
export function callsFor(calls: CapturedToolCall[], agent: CheckAgent | undefined, caseAgent = COORDINATOR): CapturedToolCall[] {
  if (agent === ANY_AGENT) return calls;
  const wanted = agent ?? caseAgent;
  return calls.filter(c => (c.agentId ?? COORDINATOR) === wanted);
}

export interface CheckContext {
  /** Identifiers that must never appear in a principal- or external-facing reply. */
  internalNames: string[];
  /** The agent the case reaches (#2025). Default: the coordinator. */
  caseAgent?: string;
}

/** "delegate", or "calendar:calendar-list-events" for a tool of an agent other than the case's. */
function checkLabel(tool: string, agent: CheckAgent | undefined, caseAgent = COORDINATOR): string {
  return agent === undefined || agent === caseAgent ? tool : `${agent}:${tool}`;
}

const NO_REPLY = 'NO_REPLY';

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}

function callMatches(
  call: CapturedToolCall,
  withArgs?: Record<string, unknown>,
  contains?: Record<string, string>,
): boolean {
  if (withArgs && !argsMatch(withArgs, call.input)) return false;
  if (contains) {
    for (const [key, needle] of Object.entries(contains)) {
      if (!stringify(call.input[key]).toLowerCase().includes(needle.toLowerCase())) return false;
    }
  }
  return true;
}

/**
 * True when `value` contains `pattern`: each key of a mapping pattern must be present and
 * contain the pattern's value in turn; anything else must be equal.
 */
export function containsSubset(pattern: unknown, value: unknown): boolean {
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isMapping(pattern)) {
    return isMapping(value) && Object.entries(pattern).every(([k, p]) => Object.hasOwn(value, k) && containsSubset(p, value[k]));
  }
  return isDeepStrictEqual(pattern, value);
}

function describeCalls(calls: CapturedToolCall[], caseAgent: string): string {
  if (calls.length === 0) return 'no tool calls';
  return calls.map(c => `${checkLabel(c.name, c.agentId ?? COORDINATOR, caseAgent)}${c.result?.success === false ? ' [failed]' : ''}(${JSON.stringify(c.input).slice(0, 160)})`).join(', ');
}

const pass = (justification: string): RunRating => ({ rating: 'PASS', justification });
const miss = (justification: string): RunRating => ({ rating: 'MISS', justification });

/** The tools a `called` check counts. */
export function calledTools(check: Extract<BehaviorCheck, { kind: 'called' }>): string[] {
  return Array.isArray(check.tool) ? check.tool : [check.tool];
}

/** A call that succeeded with data containing `returns`; any call when `returns` is unset. */
function returned(call: CapturedToolCall, returns: Record<string, unknown> | undefined): boolean {
  return returns === undefined || (call.result?.success === true && containsSubset(returns, call.result.data));
}

export function evaluateCheck(check: BehaviorCheck, run: ScenarioRun, ctx: CheckContext): RunRating {
  const caseAgent = ctx.caseAgent ?? COORDINATOR;
  const calls = check.kind === 'called' || check.kind === 'not_called' || check.kind === 'order' || check.kind === 'text'
    ? callsFor(run.toolCalls, check.agent, caseAgent)
    : run.toolCalls;
  switch (check.kind) {
    case 'called': {
      const tools = calledTools(check);
      const tool = tools.map(t => checkLabel(t, check.agent, caseAgent)).join(' | ');
      const matching = calls.filter(c =>
        tools.includes(c.name)
        && callMatches(c, check.with, check.contains)
        && (check.success === undefined || c.result?.success === check.success)
        && returned(c, check.returns));
      const min = check.min ?? 1;
      const max = check.max ?? Number.POSITIVE_INFINITY;
      if (matching.length >= min && matching.length <= max) {
        return pass(`${tool} called ${matching.length}x with the expected arguments`);
      }
      return miss(
        `expected ${tool} ${min}${Number.isFinite(max) ? `..${max}` : '+'}x matching ` +
        `${JSON.stringify({ with: check.with, contains: check.contains, ...(check.success !== undefined ? { success: check.success } : {}), ...(check.returns !== undefined ? { returns: check.returns } : {}) })}; got ${matching.length}. ` +
        `Calls: ${describeCalls(calls, caseAgent)}`,
      );
    }
    case 'not_called': {
      const offending = calls.filter(c => check.tools.includes(c.name) && callMatches(c, check.with, check.contains) && returned(c, check.returns));
      return offending.length === 0
        ? pass(`none of ${check.tools.map(t => checkLabel(t, check.agent, caseAgent)).join(', ')} called`)
        : miss(`called ${describeCalls(offending, caseAgent)}`);
    }
    case 'order': {
      let cursor = 0;
      for (const c of calls) {
        if (c.name === check.tools[cursor]) cursor++;
        if (cursor === check.tools.length) break;
      }
      const order = check.tools.map(t => checkLabel(t, check.agent, caseAgent)).join(' → ');
      return cursor === check.tools.length
        ? pass(`called ${order} in order`)
        : miss(`expected ${order} in order; calls: ${describeCalls(calls, caseAgent)}`);
    }
    case 'reply': {
      if (run.reply === null) return miss(`${caseAgent === COORDINATOR ? 'the coordinator' : caseAgent} produced no reply`);
      const isNoReply = run.reply.trim() === NO_REPLY;
      const wanted = check.is === 'no_reply';
      return isNoReply === wanted
        ? pass(wanted ? 'replied exactly NO_REPLY' : 'replied with content')
        : miss(wanted ? `expected exactly NO_REPLY; got: ${run.reply.slice(0, 200)}` : 'replied NO_REPLY');
    }
    case 'reply_excludes': {
      // A reply-content check needs a reply. Silence trivially "contains nothing", and
      // scoring it PASS would let a coordinator that stops answering clear the gate.
      if (isSilent(run)) return miss('no reply to check (silent or NO_REPLY)');
      const reply = run.reply!;
      const hit = check.patterns.find(p => new RegExp(p, 'i').test(reply));
      return hit === undefined ? pass('reply contains none of the excluded patterns') : miss(`reply matches /${hit}/i`);
    }
    case 'reply_excludes_internal_names': {
      if (isSilent(run)) return miss('no reply to check (silent or NO_REPLY)');
      const reply = run.reply!;
      const hits = ctx.internalNames.filter(name => containsIdentifier(reply, name));
      return hits.length === 0 ? pass('reply names no internal identifier') : miss(`reply names ${hits.join(', ')}`);
    }
    case 'briefed': {
      // A run saved before #2027, or one with stubbed delegation, has no specialist runs.
      const briefs = (run.delegations ?? []).filter(d => d.agentId === check.agent).map(d => d.brief);
      if (briefs.length === 0) return miss(`no real ${check.agent} run in this run`);
      const full = briefs.find(brief => check.contains.every(n => brief.toLowerCase().includes(n.toLowerCase())));
      if (full !== undefined) return pass(`${check.agent}'s brief carries ${check.contains.join(', ')}`);
      const missing = check.contains.filter(n => !briefs.some(brief => brief.toLowerCase().includes(n.toLowerCase())));
      return miss(`no ${check.agent} brief carries all of ${check.contains.join(', ')}${missing.length > 0 ? ` (none has ${missing.join(', ')})` : ''}`);
    }
    case 'principal_note': {
      const note = run.principalNote;
      if (check.is === 'absent') {
        return note === undefined ? pass('left no note for the principal') : miss(`left a note for the principal: ${note.slice(0, 200)}`);
      }
      if (note === undefined) return miss('left no note for the principal');
      const missing = (check.contains ?? []).filter(s => !note.toLowerCase().includes(s.toLowerCase()));
      return missing.length === 0
        ? pass('left a note for the principal')
        : miss(`the note for the principal lacks ${missing.join(', ')}: ${note.slice(0, 200)}`);
    }
    case 'text': {
      let texts: string[];
      if (check.of === 'reply') {
        if (isSilent(run)) return miss('no reply to check (silent or NO_REPLY)');
        texts = [run.reply!];
      } else {
        const { tool, arg } = check.of;
        texts = calls.filter(c => c.name === tool).map(c => stringify(c.input[arg]));
        if (texts.length === 0) return miss(`no ${checkLabel(tool, check.agent, caseAgent)} call to check`);
      }
      const what = check.of === 'reply' ? 'the reply' : `${check.of.tool}.${check.of.arg}`;
      for (const text of texts) {
        const words = wordCount(text);
        if (check.maxWords !== undefined && words > check.maxWords) {
          return miss(`${what} has ${words} words (max ${check.maxWords}): ${text.slice(0, 160)}`);
        }
        const hit = check.excludes?.find(p => new RegExp(p, 'i').test(text));
        if (hit !== undefined) return miss(`${what} matches /${hit}/i: ${text.slice(0, 160)}`);
      }
      const longest = Math.max(...texts.map(wordCount));
      return pass(`${what} within limits (${texts.length > 1 ? `${texts.length} texts, longest ` : ''}${longest} words)`);
    }
    case 'any_of': {
      const ratings = check.checks.map(alt => evaluateCheck(alt, run, ctx));
      const hit = ratings.find(r => r.rating === 'PASS');
      return hit ? pass(`any_of: ${hit.justification}`) : miss(`no alternative passed: ${ratings.map(r => r.justification).join(' | ')}`);
    }
  }
}

/** A check and every alternative nested in it, for validation that inspects leaf checks. */
export function leafChecks(check: BehaviorCheck): BehaviorCheck[] {
  return check.kind === 'any_of' ? check.checks.flatMap(leafChecks) : [check];
}

/** Whitespace-separated words, the way a reader counts them. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter(w => w !== '').length;
}

function isSilent(run: ScenarioRun): boolean {
  return run.reply === null || run.reply.trim() === '' || run.reply.trim() === NO_REPLY;
}

/** Match `name` as a whole identifier, so `email-send` does not hit `email-sender`. */
function containsIdentifier(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, 'i').test(text);
}

/**
 * Identifiers that only make sense as internals. Plain-word names are left out:
 * "delegate" and "calendar" are ordinary English and would flag correct replies.
 * The judge covers the prose side ("my contacts specialist", "the system").
 */
export function internalNamesFor(input: { tools: string[]; agents: string[] }): string[] {
  const looksLikeIdentifier = (n: string): boolean => /[-_]/.test(n);
  const names = new Set<string>();
  for (const tool of input.tools) if (looksLikeIdentifier(tool)) names.add(tool);
  for (const agent of input.agents) {
    if (looksLikeIdentifier(agent)) names.add(agent);
    names.add(`@${agent}`);
  }
  return [...names].sort();
}

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
import { detectPii } from '../../src/pii/scrubber.js';
import { argsMatch } from './stub-matcher.js';
import {
  ANY_AGENT, COORDINATOR, type BehaviorCheck, type CapturedToolCall, type CheckAgent, type GATEWAY_CHECK_KINDS,
  type RecordedDelivery, type RecordedHold, type RunRating, type ScenarioRun,
} from './types.js';

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
        if (text.trim() === '') return miss(`${what} is empty on a call`);
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
    case 'delivered':
    case 'not_delivered':
    case 'held':
    case 'not_held':
    case 'outreach_recorded':
    case 'decision_recorded':
    case 'reviewed':
    case 'left_as_draft':
      return evaluateGatewayCheck(check, run);
    case 'any_of': {
      const ratings = check.checks.map(alt => evaluateCheck(alt, run, ctx));
      const hit = ratings.find(r => r.rating === 'PASS');
      return hit ? pass(`any_of: ${hit.justification}`) : miss(`no alternative passed: ${ratings.map(r => r.justification).join(' | ')}`);
    }
  }
}

/** How the gateway's digest item for an autonomous send that stopped for good begins (#2474 PR 2). */
const LEFT_AS_DRAFT_PREFIX = 'Left as a draft in your mailbox:';

type GatewayCheck = Extract<BehaviorCheck, { kind: typeof GATEWAY_CHECK_KINDS[number] }>;

/** `name` is one of a delivery's recipients: a seeded contact key, `principal`, or the address. */
function names(name: string, addresses: string[], named: string[]): boolean {
  const wanted = name.trim().toLowerCase();
  return [...addresses, ...named].some(a => a.toLowerCase() === wanted);
}

/**
 * `text` with each of `terms` replaced by [masked]. The terms a check names (a SIN, an account
 * number) are the values it guards; a justification lands in results JSON and logs, which must
 * carry labels only.
 */
function maskTerms(text: string, terms: readonly string[]): string {
  let masked = text;
  for (const term of terms) {
    if (term === '') continue;
    masked = masked.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[masked]');
  }
  return masked;
}

/**
 * `text` with every detected personal detail replaced by its label ([sin_ca]). A delivery can
 * carry values no check names (the phone number in a quote, a card number the drafter wrote),
 * and a justification must carry labels only. Built-in patterns: the operator's extra patterns
 * live in config the checks never read. Runs before maskTerms, so a term inside a detected value
 * leaves no partial digits behind.
 */
function maskPii(text: string): string {
  const matches = detectPii(text);
  let masked = text;
  // End to start, so earlier offsets stay valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    masked = `${masked.slice(0, m.start)}[${m.label}]${masked.slice(m.end)}`;
  }
  return masked;
}

/** The terms of a check, for a justification: how many, never what. */
function termCount(terms: readonly string[] | undefined): string | undefined {
  return terms && terms.length > 0 ? `${terms.length} term(s)` : undefined;
}

/** One delivery for a justification, with detected personal details and `mask` masked. */
function describeDelivery(d: RecordedDelivery, mask: readonly string[] = []): string {
  const text = maskTerms(maskPii((d.subject ? `${d.subject} — ` : '') + d.body), mask);
  return `${d.channel} to ${d.toNames.join(', ') || '(nobody)'}${d.ccNames.length > 0 ? ` cc ${d.ccNames.join(', ')}` : ''}: ${text.slice(0, 120)}`;
}

/** What one approval shows, for a justification, with detected personal details and `mask` masked. */
function describeHold(h: RecordedHold, mask: readonly string[]): string {
  return `approval ${h.approvalNumber ?? h.shortRef} (${h.toolName}, now ${h.outcome}): ${maskTerms(maskPii(h.preamble ?? h.description ?? h.toolName), mask).slice(0, 120)}`;
}

/**
 * The checks over a through-gateway run's sends (#2312). They read only what the run
 * recorded, so a run that did not go through the gateway misses them all: the loader allows
 * them only on `through_gateway` cases, and a run saved without the record has nothing to read.
 */
function evaluateGatewayCheck(check: GatewayCheck, run: ScenarioRun): RunRating {
  const outcome = run.gateway;
  if (!outcome) return miss('no gateway record for this run (the case does not set through_gateway)');
  // A draft never left the process.
  const delivered = outcome.deliveries.filter(d => d.kind === 'send');
  switch (check.kind) {
    case 'delivered': {
      // own_text: the reply's own words, not the sender's message quoted below them.
      const text = (d: RecordedDelivery): string =>
        `${d.subject ?? ''}\n${check.ownText ? d.ownBody ?? d.body : d.body}`.toLowerCase();
      const matching = delivered.filter(d =>
        (check.turn === undefined || d.turn === check.turn)
        && (check.channel === undefined || d.channel === check.channel)
        && (check.to === undefined || names(check.to, d.to, d.toNames))
        && (check.ccIncludes === undefined || names(check.ccIncludes, d.cc, d.ccNames))
        && (check.contains ?? []).every(s => text(d).includes(s.toLowerCase()))
        && !(check.excludes ?? []).some(s => text(d).includes(s.toLowerCase()))
        // quote_contains: the quoted message is on the wire and carries these, so a quote that was
        // dropped never passes on the reply's own words.
        && (check.quoteContains ?? []).every(s => d.quotedBody !== undefined && d.quotedBody.toLowerCase().includes(s.toLowerCase())));
      const ok = check.count === undefined ? matching.length > 0 : matching.length === check.count;
      // The check's terms never appear in a justification, only their count: `contains` with
      // count 0 and `excludes` name values that must not go out.
      const terms = [...(check.contains ?? []), ...(check.excludes ?? []), ...(check.quoteContains ?? [])];
      const wanted = JSON.stringify({
        channel: check.channel, to: check.to, cc_includes: check.ccIncludes,
        contains: termCount(check.contains), excludes: termCount(check.excludes),
        ...(check.ownText ? { own_text: true } : {}),
        ...(check.quoteContains ? { quote_contains: termCount(check.quoteContains) } : {}),
        ...(check.turn ? { turn: check.turn } : {}),
      });
      return ok
        ? pass(`${matching.length} delivery(ies) matching ${wanted}`)
        : miss(`expected ${check.count ?? '1+'} delivery(ies) matching ${wanted}; got ${matching.length}. Delivered: ${delivered.map(d => describeDelivery(d, terms)).join(' | ') || 'nothing'}`);
    }
    case 'not_delivered': {
      const offending = delivered.filter(d => check.to === undefined || names(check.to, d.to, d.toNames));
      return offending.length === 0
        ? pass(check.to === undefined ? 'nothing was delivered' : `nothing was delivered to ${check.to}`)
        : miss(`delivered ${offending.map(d => describeDelivery(d)).join(' | ')}`);
    }
    case 'held': {
      if (outcome.holds.length === 0) return miss('no approval was raised');
      const shown = (h: RecordedHold): string =>
        [h.preamble ?? '', h.description ?? '', ...(h.extraLines ?? []), h.message ?? ''].join('\n').toLowerCase();
      const hit = outcome.holds.find(h => (check.contains ?? []).every(s => shown(h).includes(s.toLowerCase())));
      return hit
        ? pass(`approval ${hit.approvalNumber ?? hit.shortRef} raised (${hit.toolName}, now ${hit.outcome})`)
        : miss(`no approval shows the ${termCount(check.contains) ?? 'given'} text: ${outcome.holds.map(h => describeHold(h, check.contains ?? [])).join(' | ')}`);
    }
    case 'not_held': {
      const shown = (h: RecordedHold): string =>
        [h.preamble ?? '', h.description ?? '', ...(h.extraLines ?? []), h.message ?? ''].join('\n').toLowerCase();
      const offending = outcome.holds.filter(h => (check.contains ?? []).every(s => shown(h).includes(s.toLowerCase())));
      return offending.length === 0
        ? pass(check.contains ? `no approval shows the ${termCount(check.contains)} text` : 'no approval was raised')
        : miss(`raised ${offending.map(h => describeHold(h, check.contains ?? [])).join(' | ')}`);
    }
    case 'outreach_recorded': {
      const matching = outcome.outreach.filter(o =>
        (check.domain === undefined || o.domains.includes(check.domain.trim().toLowerCase()))
        && (check.confirmed === undefined || o.confirmed === check.confirmed));
      return matching.length > 0
        ? pass(`outreach recorded (${matching.map(o => `${o.via} ${o.domains.join(', ') || o.addresses.length + ' address(es)'}${o.confirmed ? ', confirmed' : ''}`).join('; ')})`)
        : miss(`no outreach recorded matching ${JSON.stringify({ domain: check.domain, confirmed: check.confirmed })}; recorded: ${outcome.outreach.map(o => `${o.domains.join(', ')}${o.confirmed ? ' (confirmed)' : ''}`).join('; ') || 'none'}`);
    }
    case 'decision_recorded': {
      const label = check.label.toLowerCase();
      const hit = outcome.decisions.some(d => d.label.toLowerCase() === label && d.decision === check.decision);
      return hit
        ? pass(`the principal's ${check.decision} on ${check.label} was recorded`)
        : miss(`no ${check.decision} recorded for ${check.label}; recorded: ${outcome.decisions.map(d => `${d.label}=${d.decision}`).join(', ') || 'none'}`);
    }
    case 'reviewed': {
      const reviews = outcome.reviews ?? [];
      const label = check.label.toLowerCase();
      const hit = reviews.find(r => r.labels.some(l => l.toLowerCase() === label) && (check.outcome === undefined || r.outcome === check.outcome));
      const seen = reviews.map(r => `${r.outcome} [${r.labels.join(', ') || 'no items'}]`).join('; ') || 'no band review';
      return hit
        ? pass(`band review ruled on ${check.label} (${hit.outcome})`)
        : miss(`no band review ruled on ${check.label}${check.outcome ? ` with outcome ${check.outcome}` : ''} in a send's own text: the path was not exercised. Reviews: ${seen}`);
    }
    case 'left_as_draft': {
      // A result saved before the digest items were recorded has nothing to read: a miss, not a pass.
      if (!outcome.mailboxDigests) return miss('no principal-mailbox digest record for this run');
      // Every final autonomous stop files exactly one such item (outbound-gateway.ts
      // recordAutonomousStop), unlike the held marker, which a cooldown or a thread-less draft skips.
      const left = outcome.mailboxDigests.filter(s => s.startsWith(LEFT_AS_DRAFT_PREFIX));
      const matching = left.filter(s => (check.contains ?? []).every(t => s.toLowerCase().includes(t.toLowerCase())));
      const ok = check.count === undefined ? matching.length > 0 : matching.length === check.count;
      const wanted = JSON.stringify({ contains: termCount(check.contains), count: check.count });
      // The items name subjects and recipients; detected personal details are masked.
      const shown = left.map(s => maskPii(s).slice(0, 160)).join(' | ');
      return ok
        ? pass(`${matching.length} draft(s) left matching ${wanted}`)
        : miss(`expected ${check.count ?? '1+'} draft(s) left matching ${wanted}; got ${matching.length}. ${left.length === 0 ? 'nothing was left as a draft' : `Left: ${shown}`}`);
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

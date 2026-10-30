// tests/scenarios/loader.ts — YAML case files → ScenarioCase, validated up front.
//
// Every mistake that would otherwise surface mid-run (an unknown check, a placeholder
// for a contact the case never seeds, a sender that does not exist) is a load error
// here, so a paid run never starts on a broken case.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { hasBacklog, type PrincipalBacklogCounts } from '../../src/agents/prompts/backlog-line.js';
import { parsePinnedContext } from '../../src/agents/pinned-context.js';
import { isKnownPiiLabel } from '../../src/pii/scrubber.js';
import { registrableDomain } from '../../src/verification/domain.js';
import { hasDatePlaceholders, resolveDatePlaceholders } from '../shared/date-placeholders.js';
import { LIVE_SEARCH_TOOL } from '../shared/live-search.js';
import { leafChecks } from './assertions.js';
import { THROUGH_GATEWAY_TOOLS } from './stub-layer.js';
import {
  ANY_AGENT,
  COORDINATOR,
  GATEWAY_CHECK_KINDS,
  REVIEW_OUTCOMES,
  type BehaviorCheck,
  type BehaviorWeight,
  type DelegationMode,
  type DeliveryChannel,
  type DeliveryTurn,
  type ExpectedBehavior,
  type ReviewOutcome,
  type IdentityFixture,
  type ScenarioCase,
  type ScenarioFollowup,
  type ScenarioInbound,
  type ScenarioPrincipalTurn,
  type ScenarioWakeTask,
  type SeedBullpenThread,
  type SeedContact,
  type SeedOutboundEntry,
  type SeedOutreach,
  type SeedPinned,
  type SeedPrincipalIdentity,
  type SeedTask,
  type SeedVerification,
  type ToolStub,
} from './types.js';
import type { AutonomyFixture } from '../../src/startup/test-mode-stack.js';

const WEIGHTS: readonly BehaviorWeight[] = ['critical', 'important', 'nice-to-have'];
// 'trusted' is a grant made after creation (createContact refuses it); seeding sets it then.
const CONTACT_TIERS = ['trusted', 'known', 'unknown'] as const;
const CONTACT_KINDS = ['person', 'organization', 'automated'] as const;
const DELEGATION_MODES: readonly DelegationMode[] = ['stubbed', 'real'];

/** `{{kind:key}}` or `{{principal_contact_id}}`. */
const PLACEHOLDER = /\{\{\s*([a-z_]+)(?::([A-Za-z0-9_-]+))?\s*\}\}/g;

type Raw = Record<string, unknown>;

class CaseError extends Error {
  constructor(file: string, message: string) {
    super(`${path.basename(file)}: ${message}`);
  }
}

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reject keys the schema does not know. A typo must not be silent: `weigth: critical`
 * would quietly un-gate a behavior, `checks:` would hand a code check to the judge, and
 * `wth:` inside a check would loosen `called` to any arguments.
 */
function onlyKeys(raw: Raw, allowed: readonly string[], file: string, where: string): void {
  const unknown = Object.keys(raw).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new CaseError(file, `${where}: unknown key(s) ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
}

const CASE_KEYS = ['name', 'description', 'tags', 'agent', 'delegation', 'release_gate', 'runs', 'timeout_seconds', 'known_failure', 'stub_sets', 'live_search', 'seed', 'inbound', 'tool_stubs', 'expected_behaviors', 'failure_modes', 'identity', 'autonomy', 'through_gateway'] as const;
const SEED_KEYS = ['contacts', 'outbound_context', 'bullpen', 'backlog', 'verifications', 'principal_identities', 'tasks', 'outreach', 'pinned'] as const;
const PINNED_KEYS = ['docs', 'configs', 'unavailable'] as const;
const TASK_KEYS = ['key', 'title', 'intent', 'originator', 'agent'] as const;
const OUTREACH_KEYS = ['key', 'task', 'via', 'org_name', 'domains', 'addresses', 'contacts', 'summary', 'confirmed'] as const;
const OUTREACH_VIAS: readonly SeedOutreach['via'][] = ['email', 'web_form', 'signal', 'sms', 'slack', 'phone', 'other'];
const PRINCIPAL_IDENTITY_KEYS = ['channel', 'identifier'] as const;
/** Channels the resolver maps to the principal without an identity (seed.ts: PRINCIPAL_LOCAL_CHANNELS). */
const PRINCIPAL_LOCAL_CHANNELS = ['cli', 'smoke-test', 'web'];
const VERIFICATION_KEYS = ['key', 'site', 'page_domain', 'delivery', 'browser_session_id', 'task', 'status', 'requested_minutes_ago', 'session_alive'] as const;
const VERIFICATION_DELIVERIES: readonly SeedVerification['delivery'][] = ['email', 'sms', 'app'];
const VERIFICATION_STATUSES: readonly SeedVerification['status'][] = ['pending', 'expired', 'satisfied', 'abandoned'];
const BACKLOG_KEYS = ['decay_warnings', 'pending_approvals', 'principal_tasks'] as const;
const CONTACT_KEYS = ['key', 'display_name', 'tier', 'kind', 'role', 'channel', 'identifier', 'principal_wrote'] as const;
const ENTRY_KEYS = ['key', 'channel', 'agent', 'content', 'expected_reply', 'delegation_hint', 'metadata', 'recipients', 'replies', 'sent_minutes_ago', 'expires_in_hours', 'resume'] as const;
const RESUME_KEYS = ['agent', 'original_task', 'context'] as const;
const REPLY_KEYS = ['from', 'content'] as const;
const THREAD_KEYS = ['key', 'topic', 'creator', 'participants', 'content', 'mentions'] as const;
const INBOUND_KEYS = ['from', 'channel', 'content', 'thread', 'author', 'requester', 'email', 'task', 'followup', 'then'] as const;
const THEN_KEYS = ['content', 'channel', 'reply_to_approval'] as const;
const FOLLOWUP_KEYS = ['after', 'from', 'content', 'channel'] as const;
/** A follow-up held this long still releases the first tool, so a flag-off run can finish. */
const FOLLOWUP_MAX_DELAY_MS = 120_000;
const EMAIL_KEYS = ['nylas_message_id', 'account', 'auto_generated', 'auto_generated_signals', 'to', 'cc', 'sender_verified'] as const;
const AUTONOMY_KEYS = ['score', 'gating'] as const;
const AUTONOMY_GATINGS = ['band', 'tier'] as const;
/** Envelope tokens that are not a seeded contact key or a literal address (types.ts: inbound.email.to). */
const ENVELOPE_TOKENS = ['curia', 'principal'];
const WAKE_TASK_KEYS = ['id', 'title', 'intent', 'notes', 'tags'] as const;
const WAKE_NOTE_KEYS = ['at', 'note'] as const;
/**
 * A third party's fixture address or domain: under any `.test` name (RFC 6761 reserves the
 * TLD, so none is real). Distinct names give distinct registrable domains, so an org-domain
 * outreach link can tell fixture organizations apart (#2312). The principal stays under
 * example.test.
 */
const TEST_DOMAIN = /^([a-z0-9-]+\.)+test$/i;
const TEST_ADDRESS = /^[^@\s]+@([a-z0-9-]+\.)+test$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUB_KEYS = ['match', 'agent', 'return', 'error'] as const;
const BEHAVIOR_KEYS = ['id', 'weight', 'description', 'check'] as const;
const CHECK_KEYS: Record<string, readonly string[]> = {
  called: ['called', 'agent', 'with', 'contains', 'min', 'max', 'success', 'returns'],
  not_called: ['not_called', 'agent', 'with', 'contains', 'returns'],
  order: ['order', 'agent'],
  reply: ['reply'],
  reply_excludes: ['reply_excludes'],
  reply_excludes_internal_names: ['reply_excludes_internal_names'],
  briefed: ['briefed', 'brief_contains'],
  principal_note: ['principal_note', 'note_contains'],
  text: ['text', 'agent', 'max_words', 'excludes'],
  any_of: ['any_of'],
};
const GATEWAY_CHECK_KEYS: Record<typeof GATEWAY_CHECK_KINDS[number], readonly string[]> = {
  delivered: ['channel', 'to', 'cc_includes', 'contains', 'excludes', 'count', 'own_text', 'quote_contains', 'turn'],
  not_delivered: ['to'],
  held: ['contains'],
  not_held: ['contains'],
  outreach_recorded: ['domain', 'confirmed'],
  decision_recorded: ['label', 'decision'],
  reviewed: ['label', 'outcome'],
};
const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'signal', 'slack', 'sms'];
const TEXT_TOOL_KEYS = ['tool', 'arg'] as const;
const IDENTITY_FILE_KEYS = ['judge_brief', 'identity'] as const;
/**
 * An identity fixture sets every part of the office identity but the assistant, so a run
 * never inherits tone or preferences from whatever database it runs on. The values are
 * checked at boot by the identity service's own validation.
 */
const IDENTITY_FIXTURE_KEYS = ['tone', 'behavioralPreferences', 'constraints'] as const;

function str(raw: Raw, key: string, file: string, where: string): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim() === '') throw new CaseError(file, `${where}: '${key}' must be a non-empty string`);
  return v;
}

function optStr(raw: Raw, key: string, file: string, where: string): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new CaseError(file, `${where}: '${key}' must be a string`);
  return v;
}

function optBool(raw: Raw, key: string, file: string, where: string): boolean | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new CaseError(file, `${where}: '${key}' must be a boolean`);
  return v;
}

function optNum(raw: Raw, key: string, file: string, where: string): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new CaseError(file, `${where}: '${key}' must be a non-negative number`);
  }
  return v;
}

function mapping(raw: Raw, key: string, file: string, where: string): Raw {
  const v = raw[key];
  if (!isObject(v)) throw new CaseError(file, `${where}: '${key}' must be a mapping`);
  return v;
}

function strList(raw: Raw, key: string, file: string, where: string, required = false): string[] {
  const v = raw[key];
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string') || (required && v.length === 0)) {
    throw new CaseError(file, `${where}: '${key}' must be a ${required ? 'non-empty ' : ''}list of strings`);
  }
  return v as string[];
}

function list(raw: Raw, key: string, file: string): Raw[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isObject)) throw new CaseError(file, `'${key}' must be a list of mappings`);
  return v;
}

/**
 * A gateway check (#2312): `<kind>: { …filters }`, or `<kind>: true` with none. The filters
 * sit inside the kind's own mapping, so `contains` here (a list of texts) never meets a tool
 * check's `contains` (argument → text).
 */
function parseGatewayCheck(kind: typeof GATEWAY_CHECK_KINDS[number], raw: Raw, file: string, where: string): BehaviorCheck {
  onlyKeys(raw, [kind], file, where);
  const value = raw[kind];
  const at = `${where}.${kind}`;
  if (value !== true && !isObject(value)) throw new CaseError(file, `${where}: '${kind}' must be true or a mapping of filters`);
  const body: Raw = value === true ? {} : value;
  onlyKeys(body, GATEWAY_CHECK_KEYS[kind], file, at);
  const recipient = (key: string): string | undefined => {
    const v = optStr(body, key, file, at);
    if (v !== undefined && v.trim() === '') throw new CaseError(file, `${at}: '${key}' must be a contact key, principal or an address`);
    return v;
  };
  switch (kind) {
    case 'delivered': {
      const channel = optStr(body, 'channel', file, at);
      if (channel !== undefined && !(DELIVERY_CHANNELS as readonly string[]).includes(channel)) {
        throw new CaseError(file, `${at}: 'channel' must be one of ${DELIVERY_CHANNELS.join(', ')}`);
      }
      const count = optNum(body, 'count', file, at);
      if (count !== undefined && !Number.isInteger(count)) throw new CaseError(file, `${at}: 'count' must be a whole number`);
      const to = recipient('to');
      const cc = recipient('cc_includes');
      const contains = strList(body, 'contains', file, at);
      const excludes = strList(body, 'excludes', file, at);
      const ownText = optBool(body, 'own_text', file, at);
      if (ownText === false) throw new CaseError(file, `${at}: 'own_text' is true or absent`);
      const quoteContains = strList(body, 'quote_contains', file, at);
      const turn = optStr(body, 'turn', file, at);
      if (turn !== undefined && turn !== 'first' && turn !== 'then') throw new CaseError(file, `${at}: 'turn' must be first or then`);
      return {
        kind,
        ...(turn !== undefined ? { turn: turn as DeliveryTurn } : {}),
        ...(channel !== undefined ? { channel: channel as DeliveryChannel } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(cc !== undefined ? { ccIncludes: cc } : {}),
        ...(contains.length > 0 ? { contains } : {}),
        ...(excludes.length > 0 ? { excludes } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(ownText ? { ownText: true } : {}),
        ...(quoteContains.length > 0 ? { quoteContains } : {}),
      };
    }
    case 'not_delivered': {
      const to = recipient('to');
      return { kind, ...(to !== undefined ? { to } : {}) };
    }
    case 'held':
    case 'not_held': {
      const contains = strList(body, 'contains', file, at);
      return { kind, ...(contains.length > 0 ? { contains } : {}) };
    }
    case 'outreach_recorded': {
      const domain = optStr(body, 'domain', file, at);
      const confirmed = optBool(body, 'confirmed', file, at);
      return { kind, ...(domain !== undefined ? { domain } : {}), ...(confirmed !== undefined ? { confirmed } : {}) };
    }
    case 'decision_recorded': {
      const decision = body['decision'];
      if (decision !== 'yes' && decision !== 'no') throw new CaseError(file, `${at}: 'decision' must be yes or no`);
      return { kind, label: piiLabel(body, file, at), decision };
    }
    case 'reviewed': {
      const outcome = optStr(body, 'outcome', file, at);
      if (outcome !== undefined && !(REVIEW_OUTCOMES as readonly string[]).includes(outcome)) {
        throw new CaseError(file, `${at}: 'outcome' must be one of ${REVIEW_OUTCOMES.join(', ')}`);
      }
      return { kind, label: piiLabel(body, file, at), ...(outcome !== undefined ? { outcome: outcome as ReviewOutcome } : {}) };
    }
  }
}

/** A `label` that must name a PII pattern (built-in or extra_N): a typo would pass a `reviewed` check never or a count:0 check always. */
function piiLabel(body: Raw, file: string, at: string): string {
  const label = str(body, 'label', file, at);
  if (!isKnownPiiLabel(label)) {
    throw new CaseError(file, `${at}: 'label' ${label} is not a PII label (a built-in pattern name such as phone_us or sin_ca, or extra_N)`);
  }
  return label;
}

function parseCheck(raw: unknown, file: string, where: string): BehaviorCheck {
  if (!isObject(raw)) throw new CaseError(file, `${where}: check must be a mapping`);
  const kinds = ['called', 'not_called', 'order', 'reply', 'reply_excludes', 'reply_excludes_internal_names', 'briefed', 'principal_note', 'text', 'any_of', ...GATEWAY_CHECK_KINDS]
    .filter(k => k in raw);
  if (kinds.length !== 1) {
    throw new CaseError(file, `${where}: check needs exactly one of called, not_called, order, reply, reply_excludes, reply_excludes_internal_names, briefed, principal_note, text, any_of, ${GATEWAY_CHECK_KINDS.join(', ')} (got ${kinds.join(', ') || 'none'})`);
  }
  const gatewayKind = GATEWAY_CHECK_KINDS.find(k => k === kinds[0]);
  if (gatewayKind) return parseGatewayCheck(gatewayKind, raw, file, where);
  onlyKeys(raw, CHECK_KEYS[kinds[0]!]!, file, where);
  const withArgs = raw['with'];
  if (withArgs !== undefined && !isObject(withArgs)) throw new CaseError(file, `${where}: 'with' must be a mapping`);
  const contains = raw['contains'];
  if (contains !== undefined && (!isObject(contains) || Object.values(contains).some(v => typeof v !== 'string'))) {
    throw new CaseError(file, `${where}: 'contains' must map argument names to strings`);
  }
  const agent = optStr(raw, 'agent', file, where);
  if (agent !== undefined && agent.trim() === '') throw new CaseError(file, `${where}: 'agent' must be an agent id or '${ANY_AGENT}'`);
  const filters = {
    ...(agent !== undefined ? { agent } : {}),
    ...(withArgs ? { with: withArgs } : {}),
    ...(contains ? { contains: contains as Record<string, string> } : {}),
  };

  switch (kinds[0]) {
    case 'called':
      return {
        kind: 'called',
        tool: Array.isArray(raw['called']) ? strList(raw, 'called', file, where, true) : str(raw, 'called', file, where),
        ...filters,
        ...(optNum(raw, 'min', file, where) !== undefined ? { min: raw['min'] as number } : {}),
        ...(optNum(raw, 'max', file, where) !== undefined ? { max: raw['max'] as number } : {}),
        ...(optBool(raw, 'success', file, where) !== undefined ? { success: raw['success'] as boolean } : {}),
        ...(raw['returns'] !== undefined ? { returns: mapping(raw, 'returns', file, where) } : {}),
      };
    case 'not_called':
      return {
        kind: 'not_called',
        tools: strList(raw, 'not_called', file, where, true),
        ...filters,
        ...(raw['returns'] !== undefined ? { returns: mapping(raw, 'returns', file, where) } : {}),
      };
    case 'briefed':
      if (agent !== undefined) throw new CaseError(file, `${where}: 'briefed' names its agent itself; drop 'agent'`);
      if (raw['briefed'] === ANY_AGENT) throw new CaseError(file, `${where}: 'briefed' names one agent`);
      return { kind: 'briefed', agent: str(raw, 'briefed', file, where), contains: strList(raw, 'brief_contains', file, where, true) };
    case 'order':
      return { kind: 'order', tools: strList(raw, 'order', file, where, true), ...(agent !== undefined ? { agent } : {}) };
    case 'principal_note': {
      const is = raw['principal_note'];
      if (is !== 'present' && is !== 'absent') {
        throw new CaseError(file, `${where}: 'principal_note' must be present or absent`);
      }
      const noteContains = strList(raw, 'note_contains', file, where);
      if (is === 'absent' && noteContains.length > 0) {
        throw new CaseError(file, `${where}: 'note_contains' needs principal_note: present`);
      }
      return { kind: 'principal_note', is, ...(noteContains.length > 0 ? { contains: noteContains } : {}) };
    }
    case 'reply': {
      const is = raw['reply'];
      if (is !== 'no_reply' && is !== 'not_no_reply') {
        throw new CaseError(file, `${where}: 'reply' must be no_reply or not_no_reply`);
      }
      return { kind: 'reply', is };
    }
    case 'reply_excludes':
      return { kind: 'reply_excludes', patterns: patternList(raw, 'reply_excludes', file, where, true) };
    case 'text': {
      const source = raw['text'];
      let of: Extract<BehaviorCheck, { kind: 'text' }>['of'];
      if (source === 'reply') {
        if (agent !== undefined) throw new CaseError(file, `${where}: 'agent' is for a tool's text; the reply is the case agent's`);
        of = 'reply';
      } else if (isObject(source)) {
        onlyKeys(source, TEXT_TOOL_KEYS, file, `${where}.text`);
        of = { tool: str(source, 'tool', file, `${where}.text`), arg: str(source, 'arg', file, `${where}.text`) };
      } else {
        throw new CaseError(file, `${where}: 'text' must be reply or {tool, arg}`);
      }
      const maxWords = optNum(raw, 'max_words', file, where);
      if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords < 1)) {
        throw new CaseError(file, `${where}: 'max_words' must be a positive whole number`);
      }
      const excludes = patternList(raw, 'excludes', file, where, false);
      if (maxWords === undefined && excludes.length === 0) {
        throw new CaseError(file, `${where}: a text check needs max_words, excludes or both`);
      }
      return {
        kind: 'text',
        of,
        ...(agent !== undefined ? { agent } : {}),
        ...(maxWords !== undefined ? { maxWords } : {}),
        ...(excludes.length > 0 ? { excludes } : {}),
      };
    }
    case 'any_of': {
      const alternatives = raw['any_of'];
      if (!Array.isArray(alternatives) || alternatives.length === 0 || !alternatives.every(isObject)) {
        throw new CaseError(file, `${where}: 'any_of' must be a non-empty list of checks`);
      }
      return {
        kind: 'any_of',
        checks: alternatives.map((alt, i) => parseCheck(alt, file, `${where} any_of[${i}]`)),
      };
    }
    default:
      if (raw['reply_excludes_internal_names'] !== true) {
        throw new CaseError(file, `${where}: 'reply_excludes_internal_names' must be true`);
      }
      return { kind: 'reply_excludes_internal_names' };
  }
}

/** A list of case-insensitive regexes, each compiled now so a bad one fails at load. */
function patternList(raw: Raw, key: string, file: string, where: string, required: boolean): string[] {
  const patterns = strList(raw, key, file, where, required);
  for (const p of patterns) {
    try {
      new RegExp(p, 'i');
    } catch (err) {
      throw new CaseError(file, `${where}: invalid pattern /${p}/: ${(err as Error).message}`);
    }
  }
  return patterns;
}

/** Parse a `tool_stubs` mapping (also used by smoke's loader). */
export function parseStubs(raw: unknown, file: string): Record<string, ToolStub[]> {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new CaseError(file, `'tool_stubs' must be a mapping of tool name → list`);
  const stubs: Record<string, ToolStub[]> = {};
  for (const [tool, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries) || !entries.every(isObject)) {
      throw new CaseError(file, `tool_stubs.${tool} must be a list of {match, return | error}`);
    }
    stubs[tool] = entries.map((e, i) => {
      const where = `tool_stubs.${tool}[${i}]`;
      onlyKeys(e, STUB_KEYS, file, where);
      const match = e['match'] ?? {};
      if (!isObject(match)) throw new CaseError(file, `${where}: 'match' must be a mapping`);
      const hasReturn = 'return' in e;
      const hasError = 'error' in e;
      if (hasReturn === hasError) throw new CaseError(file, `${where}: give exactly one of 'return' or 'error'`);
      const scope = e['agent'] === undefined ? {} : { agent: str(e, 'agent', file, where) };
      if (hasError) return { match, ...scope, error: str(e, 'error', file, where) };
      return { match, ...scope, return: e['return'] };
    });
  }
  return stubs;
}

function parseBehaviors(raw: Raw, file: string): ExpectedBehavior[] {
  const behaviors = list(raw, 'expected_behaviors', file);
  if (behaviors.length === 0) throw new CaseError(file, `'expected_behaviors' must not be empty`);
  const seen = new Set<string>();
  return behaviors.map((b, i) => {
    const where = `expected_behaviors[${i}]`;
    onlyKeys(b, BEHAVIOR_KEYS, file, where);
    const id = str(b, 'id', file, where);
    if (seen.has(id)) throw new CaseError(file, `duplicate behavior id '${id}'`);
    seen.add(id);
    const weight = (b['weight'] ?? 'important') as BehaviorWeight;
    if (!WEIGHTS.includes(weight)) throw new CaseError(file, `${where}: invalid weight '${String(b['weight'])}'`);
    return {
      id,
      description: str(b, 'description', file, where),
      weight,
      ...(b['check'] !== undefined ? { check: parseCheck(b['check'], file, `${where}.check`) } : {}),
    };
  });
}

function parseContacts(raw: Raw, file: string): SeedContact[] {
  return list(raw, 'contacts', file).map((c, i) => {
    const where = `seed.contacts[${i}]`;
    onlyKeys(c, CONTACT_KEYS, file, where);
    const tier = c['tier'] ?? 'known';
    if (!CONTACT_TIERS.includes(tier as typeof CONTACT_TIERS[number])) {
      throw new CaseError(file, `${where}: tier must be one of ${CONTACT_TIERS.join(', ')}`);
    }
    const kind = c['kind'] ?? 'person';
    if (!CONTACT_KINDS.includes(kind as typeof CONTACT_KINDS[number])) {
      throw new CaseError(file, `${where}: kind must be one of ${CONTACT_KINDS.join(', ')}`);
    }
    const principalWrote = c['principal_wrote'];
    if (principalWrote !== undefined && typeof principalWrote !== 'boolean') {
      throw new CaseError(file, `${where}: principal_wrote must be true or false`);
    }
    if (principalWrote === true && c['channel'] !== 'email') {
      throw new CaseError(file, `${where}: principal_wrote needs an email contact (it stands for mail in the principal's Sent folder)`);
    }
    return {
      key: str(c, 'key', file, where),
      displayName: str(c, 'display_name', file, where),
      tier: tier as SeedContact['tier'],
      kind: kind as NonNullable<SeedContact['kind']>,
      role: optStr(c, 'role', file, where),
      channel: str(c, 'channel', file, where),
      identifier: str(c, 'identifier', file, where),
      ...(principalWrote === true ? { principalWrote: true } : {}),
    };
  });
}

function parseOutbound(raw: Raw, file: string): SeedOutboundEntry[] {
  return list(raw, 'outbound_context', file).map((e, i) => {
    const where = `seed.outbound_context[${i}]`;
    onlyKeys(e, ENTRY_KEYS, file, where);
    const metadata = e['metadata'];
    if (metadata !== undefined && !isObject(metadata)) throw new CaseError(file, `${where}: 'metadata' must be a mapping`);
    const resumeRaw = e['resume'];
    let resume: SeedOutboundEntry['resume'];
    if (resumeRaw !== undefined) {
      if (!isObject(resumeRaw)) throw new CaseError(file, `${where}: 'resume' must be a mapping {agent, original_task, context}`);
      onlyKeys(resumeRaw, RESUME_KEYS, file, `${where}.resume`);
      if (metadata && 'resume_token' in metadata) {
        throw new CaseError(file, `${where}: give 'resume' or metadata.resume_token, not both`);
      }
      resume = {
        agent: str(resumeRaw, 'agent', file, `${where}.resume`),
        originalTask: str(resumeRaw, 'original_task', file, `${where}.resume`),
        context: str(resumeRaw, 'context', file, `${where}.resume`),
      };
    }
    const recipients = e['recipients'] !== undefined ? strList(e, 'recipients', file, where, true) : undefined;
    const replies = e['replies'] !== undefined
      ? list(e, 'replies', file).map((r, j) => {
          const at = `${where}.replies[${j}]`;
          onlyKeys(r, REPLY_KEYS, file, at);
          const from = str(r, 'from', file, at);
          // Only a recipient's message is recorded on an entry (the Dispatcher's match).
          if (!recipients?.includes(from)) throw new CaseError(file, `${at}: 'from' must be one of the entry's recipients`);
          return { from, content: str(r, 'content', file, at) };
        })
      : undefined;
    return {
      key: str(e, 'key', file, where),
      channelId: str(e, 'channel', file, where),
      agentId: str(e, 'agent', file, where),
      content: str(e, 'content', file, where),
      expectedReply: optStr(e, 'expected_reply', file, where),
      delegationHint: optStr(e, 'delegation_hint', file, where),
      ...(metadata ? { metadata } : {}),
      ...(recipients ? { recipients } : {}),
      ...(replies ? { replies } : {}),
      sentMinutesAgo: optNum(e, 'sent_minutes_ago', file, where),
      expiresInHours: optNum(e, 'expires_in_hours', file, where),
      ...(resume ? { resume } : {}),
    };
  });
}

function parseBullpen(raw: Raw, file: string): SeedBullpenThread[] {
  return list(raw, 'bullpen', file).map((t, i) => {
    const where = `seed.bullpen[${i}]`;
    onlyKeys(t, THREAD_KEYS, file, where);
    const creator = str(t, 'creator', file, where);
    const participants = strList(t, 'participants', file, where, true);
    if (!participants.includes(creator)) throw new CaseError(file, `${where}: creator must be a participant`);
    return {
      key: str(t, 'key', file, where),
      topic: str(t, 'topic', file, where),
      creatorAgentId: creator,
      participants,
      content: str(t, 'content', file, where),
      mentionedAgentIds: strList(t, 'mentions', file, where),
    };
  });
}

/**
 * `seed.verifications` (#2017). A closed row defaults to 15 minutes old, past the
 * configured 10-minute expiry, so `expired` reads as it would in production.
 */
function parseVerifications(raw: Raw, file: string): SeedVerification[] {
  return list(raw, 'verifications', file).map((v, i) => {
    const where = `seed.verifications[${i}]`;
    onlyKeys(v, VERIFICATION_KEYS, file, where);
    const delivery = v['delivery'];
    if (!VERIFICATION_DELIVERIES.includes(delivery as SeedVerification['delivery'])) {
      throw new CaseError(file, `${where}: delivery must be one of ${VERIFICATION_DELIVERIES.join(', ')}`);
    }
    const status = v['status'] ?? 'pending';
    if (!VERIFICATION_STATUSES.includes(status as SeedVerification['status'])) {
      throw new CaseError(file, `${where}: status must be one of ${VERIFICATION_STATUSES.join(', ')}`);
    }
    const taskId = optStr(v, 'task', file, where);
    if (taskId !== undefined && !UUID.test(taskId)) throw new CaseError(file, `${where}: 'task' must be a UUID`);
    const pending = status === 'pending';
    const site = str(v, 'site', file, where);
    const pageDomain = str(v, 'page_domain', file, where);
    for (const [name, value] of [['site', site], ['page_domain', pageDomain]] as const) {
      if (registrableDomain(value) === null) throw new CaseError(file, `${where}: '${name}' must be a website or domain`);
    }
    return {
      key: str(v, 'key', file, where),
      site,
      pageDomain,
      delivery: delivery as SeedVerification['delivery'],
      browserSessionId: str(v, 'browser_session_id', file, where),
      ...(taskId !== undefined ? { taskId } : {}),
      status: status as SeedVerification['status'],
      requestedMinutesAgo: optNum(v, 'requested_minutes_ago', file, where) ?? (pending ? 1 : 15),
      sessionAlive: optBool(v, 'session_alive', file, where) ?? pending,
    };
  });
}

/** `seed.principal_identities` (#2017): one per channel, never a local one. */
function parsePrincipalIdentities(raw: Raw, file: string): SeedPrincipalIdentity[] {
  const seen = new Set<string>();
  return list(raw, 'principal_identities', file).map((p, i) => {
    const where = `seed.principal_identities[${i}]`;
    onlyKeys(p, PRINCIPAL_IDENTITY_KEYS, file, where);
    const channel = str(p, 'channel', file, where);
    const identifier = str(p, 'identifier', file, where);
    if (PRINCIPAL_LOCAL_CHANNELS.includes(channel)) {
      throw new CaseError(file, `${where}: the principal needs no identity on '${channel}'`);
    }
    if (seen.has(channel)) throw new CaseError(file, `${where}: at most one per channel`);
    seen.add(channel);
    // A fixture must never collide with a real person's address.
    if (channel === 'email' && !/@([a-z0-9-]+\.)*example\.test$/i.test(identifier)) {
      throw new CaseError(file, `${where}: email identifiers must be under example.test`);
    }
    return { channel, identifier };
  });
}

function parseTasks(raw: Raw, file: string): SeedTask[] {
  return list(raw, 'tasks', file).map((t, i) => {
    const where = `seed.tasks[${i}]`;
    onlyKeys(t, TASK_KEYS, file, where);
    const intent = optStr(t, 'intent', file, where);
    return {
      key: str(t, 'key', file, where),
      title: str(t, 'title', file, where),
      ...(intent !== undefined ? { intent } : {}),
      originator: str(t, 'originator', file, where),
      agent: optStr(t, 'agent', file, where) ?? COORDINATOR,
    };
  });
}

function parseOutreach(raw: Raw, file: string): SeedOutreach[] {
  return list(raw, 'outreach', file).map((o, i) => {
    const where = `seed.outreach[${i}]`;
    onlyKeys(o, OUTREACH_KEYS, file, where);
    const via = str(o, 'via', file, where);
    if (!(OUTREACH_VIAS as readonly string[]).includes(via)) {
      throw new CaseError(file, `${where}: via must be one of ${OUTREACH_VIAS.join(', ')}`);
    }
    const confirmed = optBool(o, 'confirmed', file, where);
    if (confirmed === undefined) throw new CaseError(file, `${where}: 'confirmed' must be true or false`);
    const task = optStr(o, 'task', file, where);
    const orgName = optStr(o, 'org_name', file, where);
    const row: SeedOutreach = {
      key: str(o, 'key', file, where),
      ...(task !== undefined ? { task } : {}),
      via: via as SeedOutreach['via'],
      ...(orgName !== undefined ? { orgName } : {}),
      domains: strList(o, 'domains', file, where).map(d => d.trim().toLowerCase()),
      addresses: strList(o, 'addresses', file, where).map(a => a.trim().toLowerCase()),
      contacts: strList(o, 'contacts', file, where),
      summary: str(o, 'summary', file, where),
      confirmed,
    };
    // Fixtures never name a real organization or person.
    for (const d of row.domains) {
      if (!TEST_DOMAIN.test(d)) throw new CaseError(file, `${where}: domain '${d}' must be a .test name`);
    }
    for (const a of row.addresses) {
      if (!TEST_ADDRESS.test(a)) throw new CaseError(file, `${where}: address '${a}' must be under a .test name`);
    }
    if (row.domains.length === 0 && row.addresses.length === 0 && row.contacts.length === 0) {
      throw new CaseError(file, `${where}: name at least one of domains, addresses or contacts (a reply must have something to match)`);
    }
    return row;
  });
}

/**
 * `seed.pinned` (#2339): `docs` maps a `/shared/` path to its text, `configs` maps
 * `<namespace>/<key>` to its value, and `unavailable` lists entries whose read fails.
 * Paths and keys are checked with the same rules as an agent's pinned_context.
 */
function parsePinned(raw: Raw, file: string): SeedPinned | undefined {
  if (raw['pinned'] === undefined) return undefined;
  const pinned: SeedPinned = { docs: {}, configs: {}, unavailable: [] };
  const block = mapping(raw, 'pinned', file, 'seed');
  onlyKeys(block, PINNED_KEYS, file, 'seed.pinned');
  const values = (key: 'docs' | 'configs'): Array<[string, string]> => {
    if (block[key] === undefined) return [];
    const m = mapping(block, key, file, 'seed.pinned');
    return Object.entries(m).map(([name, value]) => {
      if (typeof value !== 'string') throw new CaseError(file, `seed.pinned.${key}: '${name}' must be a string`);
      return [name, value];
    });
  };
  const docs = values('docs');
  const configs = values('configs');
  const unavailable = strList(block, 'unavailable', file, 'seed.pinned');
  // Classify the failing reads by their trimmed text, so ' /shared/a.md' is a document.
  const isDoc = (name: string): boolean => name.trim().startsWith('/');
  const failingDocs = unavailable.filter(isDoc);
  const failingConfigs = unavailable.filter(name => !isDoc(name));
  const docNames = [...docs.map(([name]) => name), ...failingDocs];
  const configNames = [...configs.map(([name]) => name), ...failingConfigs];
  let entries;
  try {
    entries = parsePinnedContext({ docs: docNames, configs: configNames }, 'scenario seed');
  } catch (err) {
    throw new CaseError(file, `seed.pinned: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Store each value under the canonical name validation accepted, which is what the
  // reader is asked for. parsePinnedContext returns docs first, then configs, each in the
  // order given, one entry per name (duplicates are refused above).
  const canonical = entries.map(e => (e.kind === 'doc' ? e.path : `${e.namespace}/${e.key}`));
  const docCanon = canonical.slice(0, docNames.length);
  const configCanon = canonical.slice(docNames.length);
  docs.forEach(([, text], i) => { pinned.docs[docCanon[i]!] = text; });
  configs.forEach(([, value], i) => { pinned.configs[configCanon[i]!] = value; });
  pinned.unavailable = [...docCanon.slice(docs.length), ...configCanon.slice(configs.length)];
  return pinned;
}

/** `seed.backlog`: each count a whole number, absent ones zero, at least one positive. */
function parseBacklog(raw: Raw, file: string): PrincipalBacklogCounts | undefined {
  if (raw['backlog'] === undefined) return undefined;
  const backlog = mapping(raw, 'backlog', file, 'seed');
  onlyKeys(backlog, BACKLOG_KEYS, file, 'seed.backlog');
  const count = (key: (typeof BACKLOG_KEYS)[number]): number => {
    const v = optNum(backlog, key, file, 'seed.backlog') ?? 0;
    if (!Number.isInteger(v)) throw new CaseError(file, `seed.backlog: '${key}' must be a whole number`);
    return v;
  };
  const counts = {
    decayWarnings: count('decay_warnings'),
    pendingApprovals: count('pending_approvals'),
    principalTasks: count('principal_tasks'),
  };
  if (!hasBacklog(counts)) throw new CaseError(file, `seed.backlog: at least one count must be positive (omit it for none)`);
  return counts;
}

function parseWakeTask(raw: unknown, file: string): ScenarioWakeTask {
  if (!isObject(raw)) throw new CaseError(file, `inbound.task must be a mapping`);
  onlyKeys(raw, WAKE_TASK_KEYS, file, 'inbound.task');
  const id = str(raw, 'id', file, 'inbound.task');
  // A seeded task (#2312) is named by its placeholder; the row's id fills it in per run.
  if (!UUID.test(id) && !/^\{\{\s*task:[A-Za-z0-9_-]+\s*\}\}$/.test(id)) {
    throw new CaseError(file, `inbound.task: 'id' must be a UUID or {{task:<key>}}`);
  }
  const notes = list(raw, 'notes', file).map((n, i) => {
    onlyKeys(n, WAKE_NOTE_KEYS, file, `inbound.task.notes[${i}]`);
    return { at: str(n, 'at', file, `inbound.task.notes[${i}]`), note: str(n, 'note', file, `inbound.task.notes[${i}]`) };
  });
  if (notes.length === 0) throw new CaseError(file, `inbound.task: 'notes' must list the progress the wake resumes from`);
  const tags = strList(raw, 'tags', file, 'inbound.task');
  return {
    id,
    title: str(raw, 'title', file, 'inbound.task'),
    intent: str(raw, 'intent', file, 'inbound.task'),
    notes,
    ...(tags.length > 0 ? { tags } : {}),
  };
}

function parseInbound(raw: unknown, file: string): ScenarioInbound {
  if (!isObject(raw)) throw new CaseError(file, `'inbound' must be a mapping`);
  onlyKeys(raw, INBOUND_KEYS, file, 'inbound');
  const email = raw['email'];
  if (email !== undefined && !isObject(email)) throw new CaseError(file, `inbound.email must be a mapping`);
  if (email) onlyKeys(email, EMAIL_KEYS, file, 'inbound.email');
  const from = str(raw, 'from', file, 'inbound');
  // A task wake's body is built from its task when the run starts, so it has no content.
  const taskWake = from === 'task-wake';
  if (taskWake && raw['content'] !== undefined) {
    throw new CaseError(file, `inbound from task-wake takes 'task', not 'content' (the body is built from the task)`);
  }
  if (!taskWake && raw['task'] !== undefined) throw new CaseError(file, `inbound.task is only for 'from: task-wake'`);
  const author = optStr(raw, 'author', file, 'inbound');
  if (author !== undefined && from !== 'bullpen') throw new CaseError(file, `inbound.author is only for 'from: bullpen'`);
  const requester = optStr(raw, 'requester', file, 'inbound');
  if (requester !== undefined && from !== 'delegate') throw new CaseError(file, `inbound.requester is only for 'from: delegate'`);
  return {
    from,
    channel: optStr(raw, 'channel', file, 'inbound'),
    content: taskWake ? '' : str(raw, 'content', file, 'inbound'),
    thread: optStr(raw, 'thread', file, 'inbound'),
    ...(author !== undefined ? { author } : {}),
    ...(from === 'delegate' ? { requester: requester ?? 'principal' } : {}),
    ...(taskWake ? { task: parseWakeTask(raw['task'], file) } : {}),
    ...(email
      ? {
          email: {
            nylasMessageId: optStr(email, 'nylas_message_id', file, 'inbound.email'),
            account: optStr(email, 'account', file, 'inbound.email'),
            autoGenerated: email['auto_generated'] === true,
            autoGeneratedSignals: strList(email, 'auto_generated_signals', file, 'inbound.email'),
            ...(email['to'] !== undefined ? { to: strList(email, 'to', file, 'inbound.email') } : {}),
            ...(email['cc'] !== undefined ? { cc: strList(email, 'cc', file, 'inbound.email') } : {}),
            ...(email['sender_verified'] !== undefined ? { senderVerified: optBool(email, 'sender_verified', file, 'inbound.email') } : {}),
          },
        }
      : {}),
    ...(raw['followup'] !== undefined ? { followup: parseFollowup(raw['followup'], file, from) } : {}),
    ...(raw['then'] !== undefined ? { then: parseThen(raw['then'], file) } : {}),
  };
}

/** `inbound.then` (#2312): the principal's next turn, on a channel with a verified identity. */
function parseThen(raw: unknown, file: string): ScenarioPrincipalTurn {
  if (!isObject(raw)) throw new CaseError(file, `inbound.then must be a mapping {content, channel}`);
  onlyKeys(raw, THEN_KEYS, file, 'inbound.then');
  const channel = optStr(raw, 'channel', file, 'inbound.then') ?? 'signal';
  // A live principal turn comes from a verified identity; a console channel has none.
  if (PRINCIPAL_LOCAL_CHANNELS.includes(channel)) {
    throw new CaseError(file, `inbound.then.channel must be a channel the principal has a verified identity on (not '${channel}')`);
  }
  const replyToApproval = optBool(raw, 'reply_to_approval', file, 'inbound.then');
  if (replyToApproval !== undefined && channel !== 'email') {
    throw new CaseError(file, `inbound.then.reply_to_approval needs channel: email (a reply on the approval email's thread)`);
  }
  return { content: str(raw, 'content', file, 'inbound.then'), channel, ...(replyToApproval === true ? { replyToApproval: true } : {}) };
}

function parseFollowup(raw: unknown, file: string, inboundFrom: string): ScenarioFollowup {
  if (!isObject(raw)) throw new CaseError(file, `inbound.followup must be a mapping`);
  onlyKeys(raw, FOLLOWUP_KEYS, file, 'inbound.followup');
  if (inboundFrom === 'bullpen' || inboundFrom === 'scheduler' || inboundFrom === 'task-wake' || inboundFrom === 'delegate') {
    throw new CaseError(file, `inbound.followup is only for a channel inbound (got '${inboundFrom}')`);
  }
  const afterRaw = raw['after'];
  let after: ScenarioFollowup['after'];
  if (afterRaw === 'first_tool_call') {
    after = 'first_tool_call';
  } else if (isObject(afterRaw)) {
    onlyKeys(afterRaw, ['ms'], file, 'inbound.followup.after');
    const ms = afterRaw['ms'];
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > FOLLOWUP_MAX_DELAY_MS) {
      throw new CaseError(file, `inbound.followup.after.ms must be an integer from 1 to ${FOLLOWUP_MAX_DELAY_MS}`);
    }
    after = { ms };
  } else {
    throw new CaseError(file, `inbound.followup.after must be first_tool_call or { ms: N }`);
  }
  const from = str(raw, 'from', file, 'inbound.followup');
  if (from === 'bullpen' || from === 'scheduler' || from === 'task-wake' || from === 'delegate') {
    throw new CaseError(file, `inbound.followup.from must be principal or a seeded contact`);
  }
  const channel = optStr(raw, 'channel', file, 'inbound.followup');
  return {
    after,
    from,
    content: str(raw, 'content', file, 'inbound.followup'),
    ...(channel !== undefined ? { channel } : {}),
  };
}

/** Every `{{…}}` placeholder in a value, as `kind:key` (or `kind` for keyless ones). */
export function placeholdersIn(value: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER)) found.push(m[2] ? `${m[1]}:${m[2]}` : m[1]!);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (isObject(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return found;
}

/**
 * Replace every placeholder in `value` (deeply) from `refs`, keyed `kind:key`.
 * Throws on an unknown one — the loader has already validated them, so this only
 * fires on a harness bug.
 */
export function resolvePlaceholders<T>(value: T, refs: ReadonlyMap<string, string>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(PLACEHOLDER, (_whole, kind: string, key?: string) => {
        const ref = key ? `${kind}:${key}` : kind;
        const resolved = refs.get(ref);
        if (resolved === undefined) throw new Error(`Unresolved scenario placeholder {{${ref}}}`);
        return resolved;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The instant and timezone a run resolved its date placeholders against. */
export interface RunClock {
  /** ISO timestamp. */
  now: string;
  timezone: string;
}

/**
 * Resolve a case value for one finished run: dates against the run's own clock, then
 * the rows it seeded. Rating happens after the run, possibly past midnight, so "today"
 * must be the run's, not the rater's.
 *
 * Throws when the value has date placeholders and the run has no clock (a transcript
 * saved before #1958). Resolving against "now" would rate it against the wrong days,
 * and passing the placeholder through would hand the judge raw template text.
 */
export function resolveRunPlaceholders<T>(
  value: T,
  run: { refs: Record<string, string>; clock?: RunClock },
): T {
  let dated = value;
  if (hasDatePlaceholders(value)) {
    if (!run.clock) {
      throw new Error('value has date placeholders but the run has no clock to resolve them against');
    }
    dated = resolveDatePlaceholders(value, run.clock.timezone, new Date(run.clock.now));
  }
  return resolvePlaceholders(dated, new Map(Object.entries(run.refs)));
}

/** Where shared stub sets live: tests/scenarios/stubs/<name>.yaml. */
export const DEFAULT_STUBS_DIR = path.join(import.meta.dirname, 'stubs');

/** Where identity fixtures live: tests/scenarios/identities/<name>.yaml (#2143). */
export const DEFAULT_IDENTITIES_DIR = path.join(import.meta.dirname, 'identities');

/** The identity fixture a case names. Read once per case; a run checks they all agree. */
function loadIdentityFixture(name: string, file: string, dir: string): IdentityFixture {
  if (!/^[a-z0-9-]+$/.test(name)) throw new CaseError(file, `identity name '${name}' must be kebab-case`);
  const fixtureFile = path.join(dir, `${name}.yaml`);
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(fixtureFile, 'utf-8'));
  } catch (err) {
    throw new CaseError(file, `identity '${name}' could not be read: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new CaseError(fixtureFile, 'not a YAML mapping');
  onlyKeys(raw, IDENTITY_FILE_KEYS, fixtureFile, 'identity fixture');
  const config = mapping(raw, 'identity', fixtureFile, 'identity fixture');
  onlyKeys(config, IDENTITY_FIXTURE_KEYS, fixtureFile, 'identity');
  const missing = IDENTITY_FIXTURE_KEYS.filter(k => !(k in config));
  if (missing.length > 0) {
    throw new CaseError(fixtureFile, `identity: missing ${missing.join(', ')} (a fixture sets everything but the assistant)`);
  }
  // The identity service validates every field when the stack boots; these are checked
  // here too, so a malformed fixture fails at load, before any paid run.
  strList(config, 'behavioralPreferences', fixtureFile, 'identity');
  strList(config, 'constraints', fixtureFile, 'identity');
  mapping(config, 'tone', fixtureFile, 'identity');
  return {
    name,
    judgeBrief: str(raw, 'judge_brief', fixtureFile, 'identity fixture'),
    // The identity service validates the values when the stack boots.
    config: config as unknown as IdentityFixture['config'],
  };
}

export interface LoadOptions {
  /** Override for tests. */
  stubsDir?: string;
  /**
   * More stub-set directories, searched before `stubsDir`: a deployment overlay's own sets
   * (`--overlay`), which may also replace a core set of the same name.
   */
  extraStubsDirs?: string[];
  /** Override for tests. */
  identitiesDir?: string;
}

/**
 * Shared stub tables named by a case's `stub_sets`, plus `defaults` for every case. The
 * case's own stubs for a tool come first, so its specific matches win and a set
 * supplies the catch-all. A `live_search` case gets no web-search stub from `defaults`,
 * so its searches reach Tavily (#2106).
 */
function mergeStubSets(
  raw: Raw,
  own: Record<string, ToolStub[]>,
  file: string,
  stubsDirs: string[],
  liveSearch: boolean,
): { stubs: Record<string, ToolStub[]>; explicit: string[] } {
  // `defaults` always applies, last: an empty office for reads test mode cannot serve.
  const names = [...strList(raw, 'stub_sets', file, 'case').filter(n => n !== 'defaults'), 'defaults'];
  const merged: Record<string, ToolStub[]> = { ...own };
  const explicit = new Set(Object.keys(own));
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new CaseError(file, `stub set name '${name}' must be kebab-case`);
    const setFile = stubsDirs.map(dir => path.join(dir, `${name}.yaml`)).find(f => existsSync(f))
      ?? path.join(stubsDirs[stubsDirs.length - 1]!, `${name}.yaml`);
    let setRaw: unknown;
    try {
      setRaw = yaml.load(readFileSync(setFile, 'utf-8'));
    } catch (err) {
      throw new CaseError(file, `stub set '${name}' could not be read: ${(err as Error).message}`);
    }
    const set = parseStubs(setRaw, setFile);
    for (const [tool, stubs] of Object.entries(set)) {
      if (liveSearch && tool === LIVE_SEARCH_TOOL && name === 'defaults') continue;
      merged[tool] = [...(merged[tool] ?? []), ...stubs];
      if (name !== 'defaults') explicit.add(tool);
    }
  }
  // The case's own stub, or a named set's, would answer every search ahead of the real
  // tool: the case would spend nothing while claiming to test live search.
  if (liveSearch && explicit.has(LIVE_SEARCH_TOOL)) {
    throw new CaseError(file, `'live_search' is set but a stub answers ${LIVE_SEARCH_TOOL} — drop one`);
  }
  return { stubs: merged, explicit: [...explicit].sort() };
}

export function loadScenarioCase(file: string, options: LoadOptions = {}): ScenarioCase {
  const raw = yaml.load(readFileSync(file, 'utf-8'));
  if (!isObject(raw)) throw new CaseError(file, 'not a YAML mapping');
  onlyKeys(raw, CASE_KEYS, file, 'case');

  const seedRaw = raw['seed'] ?? {};
  if (!isObject(seedRaw)) throw new CaseError(file, `'seed' must be a mapping`);
  onlyKeys(seedRaw, SEED_KEYS, file, 'seed');
  const backlog = parseBacklog(seedRaw, file);
  const pinned = parsePinned(seedRaw, file);
  const seed = {
    contacts: parseContacts(seedRaw, file),
    outboundContext: parseOutbound(seedRaw, file),
    bullpen: parseBullpen(seedRaw, file),
    verifications: parseVerifications(seedRaw, file),
    principalIdentities: parsePrincipalIdentities(seedRaw, file),
    tasks: parseTasks(seedRaw, file),
    outreach: parseOutreach(seedRaw, file),
    ...(pinned && { pinned }),
    ...(backlog && { backlog }),
  };

  const runs = optNum(raw, 'runs', file, 'case');
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) {
    throw new CaseError(file, `'runs' must be a positive integer`);
  }

  let knownFailure: ScenarioCase['knownFailure'];
  const knownRaw = raw['known_failure'];
  if (knownRaw !== undefined) {
    if (!isObject(knownRaw)) throw new CaseError(file, `'known_failure' must be a mapping {issue, reason}`);
    onlyKeys(knownRaw, ['issue', 'reason'], file, 'known_failure');
    const issue = str(knownRaw, 'issue', file, 'known_failure');
    // An issue reference, so the exception has an owner and an exit.
    if (!/^#\d+$/.test(issue)) throw new CaseError(file, `known_failure.issue must look like '#1234'`);
    knownFailure = { issue, reason: str(knownRaw, 'reason', file, 'known_failure') };
  }
  const timeoutSeconds = optNum(raw, 'timeout_seconds', file, 'case');
  if (timeoutSeconds !== undefined && timeoutSeconds < 10) {
    throw new CaseError(file, `'timeout_seconds' must be at least 10`);
  }
  const delegation = (raw['delegation'] ?? 'stubbed') as DelegationMode;
  if (!DELEGATION_MODES.includes(delegation)) {
    throw new CaseError(file, `'delegation' must be one of ${DELEGATION_MODES.join(', ')}`);
  }
  const liveSearch = optBool(raw, 'live_search', file, 'case') === true;
  const stubsDirs = [...(options.extraStubsDirs ?? []), options.stubsDir ?? DEFAULT_STUBS_DIR];
  const ownStubs = parseStubs(raw['tool_stubs'], file);
  const stubSets = mergeStubSets(raw, ownStubs, file, stubsDirs, liveSearch);
  const agent = optStr(raw, 'agent', file, 'case') ?? COORDINATOR;
  if (agent.trim() === '' || agent === ANY_AGENT) throw new CaseError(file, `'agent' must name one agent`);
  const identityName = optStr(raw, 'identity', file, 'case');
  const identity = identityName === undefined
    ? undefined
    : loadIdentityFixture(identityName, file, options.identitiesDir ?? DEFAULT_IDENTITIES_DIR);
  const autonomy = parseAutonomy(raw, file);
  const releaseGate = optBool(raw, 'release_gate', file, 'case') ?? true;
  const throughGateway = optBool(raw, 'through_gateway', file, 'case');
  if (throughGateway === false) throw new CaseError(file, `'through_gateway' is true or absent`);
  // The release gate is one unfiltered run on the database's identity. An autonomy fixture
  // is pinned per case (#2312), so a case with one can join it.
  if (identity && releaseGate) {
    throw new CaseError(file, `a case with an 'identity' fixture runs on demand; set release_gate: false`);
  }
  const scenario: ScenarioCase = {
    name: str(raw, 'name', file, 'case'),
    description: optStr(raw, 'description', file, 'case') ?? '',
    tags: strList(raw, 'tags', file, 'case'),
    agent,
    delegation,
    releaseGate,
    ...(runs !== undefined ? { runs } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(knownFailure ? { knownFailure } : {}),
    seed,
    inbound: parseInbound(raw['inbound'], file),
    toolStubs: stubSets.stubs,
    explicitStubTools: stubSets.explicit,
    ownStubTools: Object.keys(ownStubs).sort(),
    ...(liveSearch ? { liveSearch: true as const } : {}),
    expectedBehaviors: parseBehaviors(raw, file),
    failureModes: strList(raw, 'failure_modes', file, 'case'),
    ...(identity ? { identity } : {}),
    ...(autonomy ? { autonomy } : {}),
    ...(throughGateway ? { throughGateway: true as const } : {}),
    sourceFile: file,
  };

  validateReferences(scenario, file);
  validateDelegation(scenario, file);
  validateEnvelope(scenario, file);
  validateThroughGateway(scenario, file);
  return scenario;
}

/**
 * The gateway checks read what a through-gateway run sent (#2312), so they need the case to
 * set `through_gateway`; elsewhere they would miss on every run. A stub for a tool that runs
 * for real there would never answer, so it is a mistake too.
 */
function validateThroughGateway(scenario: ScenarioCase, file: string): void {
  for (const b of scenario.expectedBehaviors) {
    for (const check of b.check ? leafChecks(b.check) : []) {
      if (!scenario.throughGateway && (GATEWAY_CHECK_KINDS as readonly string[]).includes(check.kind)) {
        throw new CaseError(file, `behavior '${b.id}': a '${check.kind}' check needs through_gateway: true`);
      }
    }
  }
  if (!scenario.throughGateway) return;
  // Only the case's own stubs: a shared set (human-channels) stubs every send, and those go unused.
  for (const tool of scenario.ownStubTools) {
    if (THROUGH_GATEWAY_TOOLS.has(tool)) {
      throw new CaseError(file, `tool_stubs.${tool}: through_gateway runs ${tool} for real; remove its stubs`);
    }
  }
}

/** A case's `autonomy:` fixture: a score in 0..100 and the gating its prompt block describes. */
function parseAutonomy(raw: Raw, file: string): AutonomyFixture | undefined {
  if (raw['autonomy'] === undefined) return undefined;
  const autonomy = mapping(raw, 'autonomy', file, 'case');
  onlyKeys(autonomy, AUTONOMY_KEYS, file, 'autonomy');
  const score = autonomy['score'];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new CaseError(file, `autonomy: 'score' must be an integer from 0 to 100`);
  }
  const gating = str(autonomy, 'gating', file, 'autonomy');
  if (!(AUTONOMY_GATINGS as readonly string[]).includes(gating)) {
    throw new CaseError(file, `autonomy: 'gating' must be one of ${AUTONOMY_GATINGS.join(', ')}`);
  }
  return { score, gating: gating as AutonomyFixture['gating'] };
}

/**
 * An email envelope (inbound.email.to / cc) names Curia exactly once: it received the
 * message, as a To or a CC. Every other entry is the principal, a seeded contact or an
 * address under a .test name.
 */
function validateEnvelope(scenario: ScenarioCase, file: string): void {
  const { to, cc } = scenario.inbound.email ?? {};
  if (to === undefined && cc === undefined) return;
  // The channel the inbound actually arrives on: the principal's is the case's `channel`
  // (default cli), a seeded contact's is its own. Any other sender has no email envelope.
  const { from } = scenario.inbound;
  const sender = scenario.seed.contacts.find(c => c.key === from);
  const channel = from === 'principal' ? (scenario.inbound.channel ?? 'cli') : sender?.channel;
  if (channel !== 'email') {
    throw new CaseError(file, `inbound.email.to / cc need an email inbound (from '${from}' arrives on ${channel ?? 'no channel'})`);
  }
  const all = [...(to ?? []), ...(cc ?? [])];
  if (all.filter(t => t === 'curia').length !== 1) {
    throw new CaseError(file, `inbound.email: 'curia' must appear exactly once across to and cc`);
  }
  const contactKeys = new Set(scenario.seed.contacts.map(c => c.key));
  for (const token of all) {
    if (ENVELOPE_TOKENS.includes(token) || contactKeys.has(token)) continue;
    if (!TEST_ADDRESS.test(token)) {
      throw new CaseError(file, `inbound.email: '${token}' is not curia, principal, a seeded contact key, or an address under a .test name`);
    }
  }
}

/**
 * Rules that only make sense for one delegation mode (#2027). In a real-delegation case a
 * `delegate` stub would silently replace the specialist the case exists to run. In a
 * stubbed one no specialist runs, so a check or stub scoped to one could never see a call.
 */
function validateDelegation(scenario: ScenarioCase, file: string): void {
  const real = scenario.delegation === 'real';
  if (real && scenario.agent !== COORDINATOR) {
    // The coordinator is the agent that delegates; a case aimed at a specialist runs it alone.
    throw new CaseError(file, `delegation: real starts from the coordinator; a case for '${scenario.agent}' stubs delegation`);
  }
  if (real && scenario.toolStubs['delegate']) {
    throw new CaseError(file, `delegation: real runs the specialist; remove the 'delegate' stubs`);
  }
  if (real) return;
  // Only the case's agent runs, so a stub or check scoped to any other could never see a call.
  for (const [tool, stubs] of Object.entries(scenario.toolStubs)) {
    if (stubs.some(s => s.agent !== undefined && s.agent !== scenario.agent)) {
      throw new CaseError(file, `tool_stubs.${tool}: a stub scoped to another agent than '${scenario.agent}' needs delegation: real`);
    }
  }
  for (const b of scenario.expectedBehaviors) {
    for (const check of b.check ? leafChecks(b.check) : []) {
      if (check.kind === 'briefed') {
        throw new CaseError(file, `behavior '${b.id}': a 'briefed' check needs delegation: real`);
      }
      if ('agent' in check && check.agent !== undefined && check.agent !== scenario.agent) {
        throw new CaseError(file, `behavior '${b.id}': a check on agent '${check.agent}' needs delegation: real`);
      }
    }
  }
}

function validateReferences(scenario: ScenarioCase, file: string): void {
  const keys = new Map<string, Set<string>>([
    ['contact', new Set()],
    ['entry', new Set()],
    ['thread', new Set()],
    ['resume_token', new Set()],
    ['verification', new Set()],
    ['task', new Set()],
    ['outreach', new Set()],
  ]);
  const add = (kind: string, key: string): void => {
    const set = keys.get(kind)!;
    if (set.has(key)) throw new CaseError(file, `duplicate ${kind} key '${key}'`);
    set.add(key);
  };
  scenario.seed.contacts.forEach(c => add('contact', c.key));
  scenario.seed.outboundContext.forEach(e => add('entry', e.key));
  scenario.seed.outboundContext.filter(e => e.resume).forEach(e => add('resume_token', e.key));
  scenario.seed.bullpen.forEach(t => add('thread', t.key));
  scenario.seed.verifications.forEach(v => add('verification', v.key));
  scenario.seed.tasks.forEach(t => add('task', t.key));
  scenario.seed.outreach.forEach(o => add('outreach', o.key));
  const contactKeys = keys.get('contact')!;
  for (const t of scenario.seed.tasks) {
    if (t.originator !== 'principal' && !contactKeys.has(t.originator)) {
      throw new CaseError(file, `seed.tasks '${t.key}': originator '${t.originator}' is not principal or a seeded contact key`);
    }
  }
  for (const o of scenario.seed.outreach) {
    if (o.task !== undefined && !keys.get('task')!.has(o.task)) {
      throw new CaseError(file, `seed.outreach '${o.key}': task '${o.task}' is not a seeded task key`);
    }
    for (const c of o.contacts) {
      if (!contactKeys.has(c)) throw new CaseError(file, `seed.outreach '${o.key}': contact '${c}' is not a seeded contact key`);
    }
  }
  // Seeding opens each row as pending (one pending row per site, a unique index) before
  // setting its status, so a second row for the site would reuse the first.
  const sites = scenario.seed.verifications.map(v => registrableDomain(v.site) ?? v.site.toLowerCase());
  if (new Set(sites).size < sites.length) {
    throw new CaseError(file, `seed.verifications: at most one verification per site`);
  }

  // failure_modes go to the judge as written; a placeholder there would reach it raw.
  if (placeholdersIn(scenario.failureModes).length > 0 || hasDatePlaceholders(scenario.failureModes)) {
    throw new CaseError(file, `failure_modes cannot contain {{…}} placeholders`);
  }
  // The description reaches the judge as written too. Say "next week", not a date.
  if (hasDatePlaceholders(scenario.description)) {
    throw new CaseError(file, `description cannot contain date placeholders`);
  }
  // Date placeholders resolve per run, before seeded-row ones (tests/shared/
  // date-placeholders.ts, shared with smoke). Resolve them once now, against an arbitrary
  // clock: a malformed one throws here instead of mid-run, and the seeded-row check below
  // then sees exactly what a run would. Anything date-shaped the resolver does not handle
  // (`{{date}}`, `{{timezone:x}}`) is left in place and fails that check as unknown.
  let dated: Raw;
  try {
    dated = resolveDatePlaceholders(
      { seed: scenario.seed, inbound: scenario.inbound, toolStubs: scenario.toolStubs, behaviors: scenario.expectedBehaviors },
      'UTC',
      new Date(0),
    );
  } catch (err) {
    throw new CaseError(file, `date placeholder: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fixture contacts must never collide with a real person's address.
  for (const c of scenario.seed.contacts) {
    if (c.channel === 'email' && !TEST_ADDRESS.test(c.identifier)) {
      throw new CaseError(file, `seed contact '${c.key}': email identifiers must be under a .test name (e.g. example.test)`);
    }
  }

  for (const ref of placeholdersIn(dated)) {
    if (ref === 'principal_contact_id') continue;
    const [kind, key] = ref.split(':');
    if (!key || !keys.has(kind!)) throw new CaseError(file, `unknown placeholder {{${ref}}}`);
    if (!keys.get(kind!)!.has(key)) throw new CaseError(file, `placeholder {{${ref}}} names no seeded ${kind}`);
  }

  const { from, thread, channel } = scenario.inbound;
  const toSpecialist = scenario.agent !== COORDINATOR;
  // The Dispatcher hands a channel inbound to the coordinator; a specialist hears from the
  // coordinator, a thread, its schedule, or a task of its own waking.
  if (toSpecialist && !['delegate', 'bullpen', 'scheduler', 'task-wake'].includes(from)) {
    throw new CaseError(file, `a case for '${scenario.agent}' takes inbound from delegate, bullpen, scheduler or task-wake (got '${from}')`);
  }
  if (!toSpecialist && from === 'delegate') {
    throw new CaseError(file, `inbound from delegate fires a specialist; set the case's 'agent'`);
  }
  if (from === 'bullpen') {
    if (!thread || !keys.get('thread')!.has(thread)) {
      throw new CaseError(file, `inbound from bullpen needs 'thread' naming a seeded thread`);
    }
    const seeded = scenario.seed.bullpen.find(t => t.key === thread)!;
    if (!seeded.participants.includes(scenario.agent)) {
      throw new CaseError(file, `inbound thread '${thread}' must have '${scenario.agent}' as a participant`);
    }
    const author = scenario.inbound.author ?? seeded.creatorAgentId;
    if (!seeded.participants.includes(author) || author === scenario.agent) {
      throw new CaseError(file, `inbound.author '${author}' must be another participant of thread '${thread}'`);
    }
  } else if (from === 'delegate') {
    const requester = scenario.inbound.requester ?? 'principal';
    if (requester !== 'principal') {
      const contact = scenario.seed.contacts.find(c => c.key === requester);
      if (!contact) throw new CaseError(file, `inbound.requester '${requester}' is not principal or a seeded contact`);
      if (channel && channel !== contact.channel) {
        throw new CaseError(file, `inbound.channel '${channel}' differs from contact '${requester}' channel '${contact.channel}'`);
      }
    }
    if (thread) throw new CaseError(file, `inbound from delegate takes no thread`);
  } else if (from === 'scheduler' || from === 'task-wake') {
    // A scheduled job has no sender, channel choice, thread or email envelope.
    if (channel || thread || scenario.inbound.email) {
      throw new CaseError(file, `inbound from ${from} takes no channel, thread or email`);
    }
  } else if (from !== 'principal') {
    const contact = scenario.seed.contacts.find(c => c.key === from);
    if (!contact) throw new CaseError(file, `inbound.from '${from}' is not principal, bullpen, scheduler, task-wake, delegate or a seeded contact`);
    if (channel && channel !== contact.channel) {
      throw new CaseError(file, `inbound.channel '${channel}' differs from contact '${from}' channel '${contact.channel}'`);
    }
  }

  const follow = scenario.inbound.followup;
  // A delivery's turn is recorded only around an inbound.then (#2333).
  if (!scenario.inbound.then) {
    for (const b of scenario.expectedBehaviors) {
      if ((b.check ? leafChecks(b.check) : []).some(c => c.kind === 'delivered' && c.turn !== undefined)) {
        throw new CaseError(file, `behavior '${b.id}': a delivered check's 'turn' needs inbound.then`);
      }
    }
  }
  if (scenario.inbound.then && toSpecialist) {
    throw new CaseError(file, `inbound.then is a principal turn to the coordinator; a case for '${scenario.agent}' cannot take one`);
  }
  if (follow && follow.from !== 'principal') {
    const contact = scenario.seed.contacts.find(c => c.key === follow.from);
    if (!contact) throw new CaseError(file, `inbound.followup.from '${follow.from}' is not principal or a seeded contact`);
    if (follow.channel && follow.channel !== contact.channel) {
      throw new CaseError(file, `inbound.followup.channel '${follow.channel}' differs from contact '${follow.from}' channel '${contact.channel}'`);
    }
  }
}

/** All cases in `dir`, sorted by file name. Case names must be unique (case-insensitive). */
export function loadScenarioCases(dir: string, options: LoadOptions = {}): ScenarioCase[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  const cases = files.map(f => loadScenarioCase(path.join(dir, f), options));
  const seen = new Set<string>();
  for (const c of cases) {
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate scenario name '${c.name}' in ${dir}`);
    seen.add(key);
  }
  return cases;
}

/** The cases a `pnpm scenarios` run gets, and the ones it leaves out and why. */
export interface RunSelection {
  cases: ScenarioCase[];
  /** release_gate: false cases an unfiltered run leaves out (#2027). */
  onDemandSkipped: string[];
  /** Identity-fixture cases left out because the selection holds other cases too (#2143). */
  identitySkipped: string[];
}

/**
 * Pick a run's cases from `all`. An unfiltered run is the release gate: on-demand cases join
 * it only with `onDemand` (#2027); a `caseFilter` or `tags` selection runs whatever it names.
 * A case with an identity fixture (#2143) needs the whole stack on that identity, and a run
 * has one stack, so it runs only in a selection of fixture cases alone (--tags style): never
 * in an unfiltered run, `onDemand` included, nor beside ordinary cases a wider selection also
 * picks. An autonomy fixture is the case's own (#2312), so those cases run beside any others.
 */
export function selectRunCases(
  all: readonly ScenarioCase[],
  args: { caseFilter?: string; tags?: readonly string[]; onDemand?: boolean },
): RunSelection {
  let cases = [...all];
  if (args.caseFilter !== undefined) {
    const needle = args.caseFilter.toLowerCase();
    cases = cases.filter(c => c.name.toLowerCase().includes(needle));
  }
  if (args.tags !== undefined) cases = cases.filter(c => c.tags.some(t => args.tags!.includes(t)));
  const selected = args.caseFilter !== undefined || args.tags !== undefined;
  const onDemandSkipped = selected || args.onDemand ? [] : cases.filter(c => !c.releaseGate).map(c => c.name);
  cases = cases.filter(c => !onDemandSkipped.includes(c.name));
  const hasIdentity = (c: ScenarioCase): boolean => c.identity !== undefined;
  const identitySkipped = selected && cases.every(hasIdentity) ? [] : cases.filter(hasIdentity).map(c => c.name);
  cases = cases.filter(c => !identitySkipped.includes(c.name));
  return { cases, onDemandSkipped, identitySkipped };
}

// tests/scenarios/loader.ts — YAML case files → ScenarioCase, validated up front.
//
// Every mistake that would otherwise surface mid-run (an unknown check, a placeholder
// for a contact the case never seeds, a sender that does not exist) is a load error
// here, so a paid run never starts on a broken case.
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { hasDatePlaceholders, resolveDatePlaceholders } from '../shared/date-placeholders.js';
import type {
  BehaviorCheck,
  BehaviorWeight,
  ExpectedBehavior,
  ScenarioCase,
  ScenarioInbound,
  SeedBullpenThread,
  SeedContact,
  SeedOutboundEntry,
  ToolStub,
} from './types.js';

const WEIGHTS: readonly BehaviorWeight[] = ['critical', 'important', 'nice-to-have'];
// Not 'trusted': that tier is a grant made after creation, and createContact refuses it.
const CONTACT_TIERS = ['known', 'unknown'] as const;
const CONTACT_KINDS = ['person', 'organization', 'automated'] as const;

/** `{{kind:key}}` or `{{principal_contact_id}}`. */
const PLACEHOLDER = /\{\{\s*([a-z_]+)(?::([A-Za-z0-9_-]+))?\s*\}\}/g;

/**
 * Relative-date kinds (tests/shared/date-placeholders.ts, shared with smoke). They are
 * resolved per run against that run's clock, before seeded-row placeholders, so the
 * seeded-row check skips them. Some forms (`{{date:today}}`, `{{timezone}}`) also match
 * PLACEHOLDER's shape and would otherwise read as unknown kinds.
 */
const DATE_KINDS = new Set(['date', 'time', 'weekday', 'day', 'at', 'timezone']);

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

const CASE_KEYS = ['name', 'description', 'tags', 'runs', 'timeout_seconds', 'known_failure', 'stub_sets', 'seed', 'inbound', 'tool_stubs', 'expected_behaviors', 'failure_modes'] as const;
const SEED_KEYS = ['contacts', 'outbound_context', 'bullpen'] as const;
const CONTACT_KEYS = ['key', 'display_name', 'tier', 'kind', 'role', 'channel', 'identifier'] as const;
const ENTRY_KEYS = ['key', 'channel', 'agent', 'content', 'expected_reply', 'delegation_hint', 'metadata', 'sent_minutes_ago', 'expires_in_hours'] as const;
const THREAD_KEYS = ['key', 'topic', 'creator', 'participants', 'content', 'mentions'] as const;
const INBOUND_KEYS = ['from', 'channel', 'content', 'thread', 'email'] as const;
const EMAIL_KEYS = ['nylas_message_id', 'auto_generated', 'auto_generated_signals'] as const;
const STUB_KEYS = ['match', 'return', 'error'] as const;
const BEHAVIOR_KEYS = ['id', 'weight', 'description', 'check'] as const;
const CHECK_KEYS: Record<string, readonly string[]> = {
  called: ['called', 'with', 'contains', 'min', 'max'],
  not_called: ['not_called', 'with', 'contains'],
  order: ['order'],
  reply: ['reply'],
  reply_excludes: ['reply_excludes'],
  reply_excludes_internal_names: ['reply_excludes_internal_names'],
  any_of: ['any_of'],
};

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

function optNum(raw: Raw, key: string, file: string, where: string): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new CaseError(file, `${where}: '${key}' must be a non-negative number`);
  }
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

function parseCheck(raw: unknown, file: string, where: string): BehaviorCheck {
  if (!isObject(raw)) throw new CaseError(file, `${where}: check must be a mapping`);
  const kinds = ['called', 'not_called', 'order', 'reply', 'reply_excludes', 'reply_excludes_internal_names', 'any_of']
    .filter(k => k in raw);
  if (kinds.length !== 1) {
    throw new CaseError(file, `${where}: check needs exactly one of called, not_called, order, reply, reply_excludes, reply_excludes_internal_names, any_of (got ${kinds.join(', ') || 'none'})`);
  }
  onlyKeys(raw, CHECK_KEYS[kinds[0]!]!, file, where);
  const withArgs = raw['with'];
  if (withArgs !== undefined && !isObject(withArgs)) throw new CaseError(file, `${where}: 'with' must be a mapping`);
  const contains = raw['contains'];
  if (contains !== undefined && (!isObject(contains) || Object.values(contains).some(v => typeof v !== 'string'))) {
    throw new CaseError(file, `${where}: 'contains' must map argument names to strings`);
  }
  const filters = {
    ...(withArgs ? { with: withArgs } : {}),
    ...(contains ? { contains: contains as Record<string, string> } : {}),
  };

  switch (kinds[0]) {
    case 'called':
      return {
        kind: 'called',
        tool: str(raw, 'called', file, where),
        ...filters,
        ...(optNum(raw, 'min', file, where) !== undefined ? { min: raw['min'] as number } : {}),
        ...(optNum(raw, 'max', file, where) !== undefined ? { max: raw['max'] as number } : {}),
      };
    case 'not_called':
      return { kind: 'not_called', tools: strList(raw, 'not_called', file, where, true), ...filters };
    case 'order':
      return { kind: 'order', tools: strList(raw, 'order', file, where, true) };
    case 'reply': {
      const is = raw['reply'];
      if (is !== 'no_reply' && is !== 'not_no_reply') {
        throw new CaseError(file, `${where}: 'reply' must be no_reply or not_no_reply`);
      }
      return { kind: 'reply', is };
    }
    case 'reply_excludes': {
      const patterns = strList(raw, 'reply_excludes', file, where, true);
      for (const p of patterns) {
        try {
          new RegExp(p, 'i');
        } catch (err) {
          throw new CaseError(file, `${where}: invalid pattern /${p}/: ${(err as Error).message}`);
        }
      }
      return { kind: 'reply_excludes', patterns };
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
      if (hasError) return { match, error: str(e, 'error', file, where) };
      return { match, return: e['return'] };
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
    return {
      key: str(c, 'key', file, where),
      displayName: str(c, 'display_name', file, where),
      tier: tier as SeedContact['tier'],
      kind: kind as NonNullable<SeedContact['kind']>,
      role: optStr(c, 'role', file, where),
      channel: str(c, 'channel', file, where),
      identifier: str(c, 'identifier', file, where),
    };
  });
}

function parseOutbound(raw: Raw, file: string): SeedOutboundEntry[] {
  return list(raw, 'outbound_context', file).map((e, i) => {
    const where = `seed.outbound_context[${i}]`;
    onlyKeys(e, ENTRY_KEYS, file, where);
    const metadata = e['metadata'];
    if (metadata !== undefined && !isObject(metadata)) throw new CaseError(file, `${where}: 'metadata' must be a mapping`);
    return {
      key: str(e, 'key', file, where),
      channelId: str(e, 'channel', file, where),
      agentId: str(e, 'agent', file, where),
      content: str(e, 'content', file, where),
      expectedReply: optStr(e, 'expected_reply', file, where),
      delegationHint: optStr(e, 'delegation_hint', file, where),
      ...(metadata ? { metadata } : {}),
      sentMinutesAgo: optNum(e, 'sent_minutes_ago', file, where),
      expiresInHours: optNum(e, 'expires_in_hours', file, where),
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

function parseInbound(raw: unknown, file: string): ScenarioInbound {
  if (!isObject(raw)) throw new CaseError(file, `'inbound' must be a mapping`);
  onlyKeys(raw, INBOUND_KEYS, file, 'inbound');
  const email = raw['email'];
  if (email !== undefined && !isObject(email)) throw new CaseError(file, `inbound.email must be a mapping`);
  if (email) onlyKeys(email, EMAIL_KEYS, file, 'inbound.email');
  return {
    from: str(raw, 'from', file, 'inbound'),
    channel: optStr(raw, 'channel', file, 'inbound'),
    content: str(raw, 'content', file, 'inbound'),
    thread: optStr(raw, 'thread', file, 'inbound'),
    ...(email
      ? {
          email: {
            nylasMessageId: optStr(email, 'nylas_message_id', file, 'inbound.email'),
            autoGenerated: email['auto_generated'] === true,
            autoGeneratedSignals: strList(email, 'auto_generated_signals', file, 'inbound.email'),
          },
        }
      : {}),
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

export interface LoadOptions {
  /** Override for tests. */
  stubsDir?: string;
}

/**
 * Shared stub tables named by a case's `stub_sets`, plus `defaults` for every case. The
 * case's own stubs for a tool come first, so its specific matches win and a set
 * supplies the catch-all.
 */
function mergeStubSets(
  raw: Raw,
  own: Record<string, ToolStub[]>,
  file: string,
  stubsDir: string,
): { stubs: Record<string, ToolStub[]>; explicit: string[] } {
  // `defaults` always applies, last: an empty office for reads test mode cannot serve.
  const names = [...strList(raw, 'stub_sets', file, 'case').filter(n => n !== 'defaults'), 'defaults'];
  const merged: Record<string, ToolStub[]> = { ...own };
  const explicit = new Set(Object.keys(own));
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new CaseError(file, `stub set name '${name}' must be kebab-case`);
    const setFile = path.join(stubsDir, `${name}.yaml`);
    let setRaw: unknown;
    try {
      setRaw = yaml.load(readFileSync(setFile, 'utf-8'));
    } catch (err) {
      throw new CaseError(file, `stub set '${name}' could not be read: ${(err as Error).message}`);
    }
    const set = parseStubs(setRaw, setFile);
    for (const [tool, stubs] of Object.entries(set)) {
      merged[tool] = [...(merged[tool] ?? []), ...stubs];
      if (name !== 'defaults') explicit.add(tool);
    }
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
  const seed = {
    contacts: parseContacts(seedRaw, file),
    outboundContext: parseOutbound(seedRaw, file),
    bullpen: parseBullpen(seedRaw, file),
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
  const stubSets = mergeStubSets(raw, parseStubs(raw['tool_stubs'], file), file, options.stubsDir ?? DEFAULT_STUBS_DIR);
  const scenario: ScenarioCase = {
    name: str(raw, 'name', file, 'case'),
    description: optStr(raw, 'description', file, 'case') ?? '',
    tags: strList(raw, 'tags', file, 'case'),
    ...(runs !== undefined ? { runs } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(knownFailure ? { knownFailure } : {}),
    seed,
    inbound: parseInbound(raw['inbound'], file),
    toolStubs: stubSets.stubs,
    explicitStubTools: stubSets.explicit,
    expectedBehaviors: parseBehaviors(raw, file),
    failureModes: strList(raw, 'failure_modes', file, 'case'),
    sourceFile: file,
  };

  validateReferences(scenario, file);
  return scenario;
}

function validateReferences(scenario: ScenarioCase, file: string): void {
  const keys = new Map<string, Set<string>>([
    ['contact', new Set()],
    ['entry', new Set()],
    ['thread', new Set()],
  ]);
  const add = (kind: string, key: string): void => {
    const set = keys.get(kind)!;
    if (set.has(key)) throw new CaseError(file, `duplicate ${kind} key '${key}'`);
    set.add(key);
  };
  scenario.seed.contacts.forEach(c => add('contact', c.key));
  scenario.seed.outboundContext.forEach(e => add('entry', e.key));
  scenario.seed.bullpen.forEach(t => add('thread', t.key));

  // failure_modes go to the judge as written; a placeholder there would reach it raw.
  if (placeholdersIn(scenario.failureModes).length > 0 || hasDatePlaceholders(scenario.failureModes)) {
    throw new CaseError(file, `failure_modes cannot contain {{…}} placeholders`);
  }
  // The description reaches the judge as written too. Say "next week", not a date.
  if (hasDatePlaceholders(scenario.description)) {
    throw new CaseError(file, `description cannot contain date placeholders`);
  }
  // A malformed date placeholder throws at resolution. Resolve once now, against an
  // arbitrary clock, so that is a load error and not a mid-run one.
  try {
    resolveDatePlaceholders(
      { seed: scenario.seed, inbound: scenario.inbound, toolStubs: scenario.toolStubs, behaviors: scenario.expectedBehaviors },
      'UTC',
      new Date(0),
    );
  } catch (err) {
    throw new CaseError(file, `date placeholder: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Fixture contacts must never collide with a real person's address.
  for (const c of scenario.seed.contacts) {
    if (c.channel === 'email' && !/@([a-z0-9-]+\.)*example\.test$/i.test(c.identifier)) {
      throw new CaseError(file, `seed contact '${c.key}': email identifiers must be under example.test`);
    }
  }

  for (const ref of placeholdersIn({
    seed: scenario.seed,
    inbound: scenario.inbound,
    toolStubs: scenario.toolStubs,
    behaviors: scenario.expectedBehaviors,
  })) {
    if (ref === 'principal_contact_id') continue;
    const [kind, key] = ref.split(':');
    if (DATE_KINDS.has(kind!)) continue;
    if (!key || !keys.has(kind!)) throw new CaseError(file, `unknown placeholder {{${ref}}}`);
    if (!keys.get(kind!)!.has(key)) throw new CaseError(file, `placeholder {{${ref}}} names no seeded ${kind}`);
  }

  const { from, thread, channel } = scenario.inbound;
  if (from === 'bullpen') {
    if (!thread || !keys.get('thread')!.has(thread)) {
      throw new CaseError(file, `inbound from bullpen needs 'thread' naming a seeded thread`);
    }
  } else if (from !== 'principal') {
    const contact = scenario.seed.contacts.find(c => c.key === from);
    if (!contact) throw new CaseError(file, `inbound.from '${from}' is not principal, bullpen or a seeded contact`);
    if (channel && channel !== contact.channel) {
      throw new CaseError(file, `inbound.channel '${channel}' differs from contact '${from}' channel '${contact.channel}'`);
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

import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseStubs } from '../scenarios/loader.js';
import type { ToolStub } from '../scenarios/types.js';
import { resolveDatePlaceholders } from '../shared/date-placeholders.js';
import { resolvePrincipalPlaceholders } from './fixtures.js';
import {
  SMOKE_SENDERS,
  TARGET_DELIVERIES,
  type BehaviorWeight,
  type CaseTarget,
  type ExpectedBehavior,
  type SmokeSender,
  type TargetDelivery,
  type TestCase,
  type Turn,
} from './types.js';

const VALID_WEIGHTS: BehaviorWeight[] = ['critical', 'important', 'nice-to-have'];

// Shape of the raw YAML before we normalize field names (snake_case → camelCase).
interface RawTestCase {
  name?: string;
  description?: string;
  tags?: string[];
  sender?: unknown;
  target?: unknown;
  judge_tool_calls?: unknown;
  tool_stubs?: unknown;
  known_failure?: unknown;
  turns?: Array<{ role?: string; content?: string; delay_ms?: number; tool_stubs?: unknown }>;
  expected_behaviors?: Array<{ id?: string; description?: string; weight?: string }>;
  failure_modes?: string[];
}

// A misspelt key (`judge_tool_call`, `senders`) would otherwise be dropped silently and the
// case would run with the default — passing for the wrong reason.
const CASE_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'tags', 'sender', 'target', 'judge_tool_calls', 'tool_stubs', 'known_failure',
  'turns', 'expected_behaviors', 'failure_modes',
]);
const TURN_KEYS: ReadonlySet<string> = new Set(['role', 'content', 'delay_ms', 'tool_stubs']);
const TARGET_KEYS: ReadonlySet<string> = new Set(['agent', 'via', 'from', 'topic', 'opening']);

/** Agent names are lowercase and hyphenated (the registry rejects anything else at boot). */
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * `target: { agent, via: bullpen, from, topic, opening }` — a case that addresses a
 * specialist (#1977). Whether the agents exist is checked against the registry before a
 * run (targetProblems below), since the loader does not boot the stack.
 */
function parseTarget(raw: unknown, filePath: string): CaseTarget | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`'target' must be a mapping in ${filePath}`);
  }
  const t = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(t).filter(k => !TARGET_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown key(s) ${unknownKeys.map(k => `'${k}'`).join(', ')} in target of ${filePath}`);
  }
  for (const key of ['agent', 'from'] as const) {
    if (typeof t[key] !== 'string' || !AGENT_NAME.test(t[key])) {
      throw new Error(`'target.${key}' must be an agent name in ${filePath}`);
    }
  }
  if (t['agent'] === t['from']) {
    throw new Error(`'target.from' must be another agent than 'target.agent' in ${filePath}`);
  }
  if (!TARGET_DELIVERIES.includes(t['via'] as TargetDelivery)) {
    throw new Error(`Invalid target.via '${String(t['via'])}' in ${filePath} — use ${TARGET_DELIVERIES.join(' or ')}`);
  }
  for (const key of ['topic', 'opening'] as const) {
    if (typeof t[key] !== 'string' || t[key].trim() === '') {
      throw new Error(`'target.${key}' must be non-empty text in ${filePath}`);
    }
  }
  // Each field was checked above; the cast only names the shape.
  return t as unknown as CaseTarget;
}

/** `known_failure: { issue: "#123" }` — the tracking issue is required, so the marker can be retired. */
function parseKnownFailure(raw: unknown, filePath: string): { issue: string } | undefined {
  if (raw === undefined) return undefined;
  const issue = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['issue'] : undefined;
  if (typeof issue !== 'string' || !/^#\d+$/.test(issue) || Object.keys(raw as object).length !== 1) {
    throw new Error(`'known_failure' must be { issue: "#<number>" } in ${filePath}`);
  }
  return { issue };
}

/**
 * Load a single YAML test case from a file path.
 * Validates required fields and normalizes the structure into a TestCase.
 * Throws if the file is missing, malformed, or fails validation.
 */
export function loadTestCase(filePath: string): TestCase {
  // readFileSync will throw ENOENT if the file doesn't exist — that's the
  // intended behavior for the "validates required fields" test.
  const raw = yaml.load(readFileSync(filePath, 'utf-8')) as RawTestCase;

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid test case file: ${filePath}`);
  }
  const unknownKeys = Object.keys(raw).filter(k => !CASE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown key(s) ${unknownKeys.map(k => `'${k}'`).join(', ')} in ${filePath}`);
  }
  if (!raw.name) throw new Error(`Missing 'name' in ${filePath}`);
  const sender = raw.sender ?? 'principal';
  if (!SMOKE_SENDERS.includes(sender as SmokeSender)) {
    throw new Error(`Invalid sender '${String(raw.sender)}' in ${filePath} — use ${SMOKE_SENDERS.join(' or ')}`);
  }
  if (raw.judge_tool_calls !== undefined && typeof raw.judge_tool_calls !== 'boolean') {
    throw new Error(`'judge_tool_calls' must be true or false in ${filePath}`);
  }
  const knownFailure = parseKnownFailure(raw.known_failure, filePath);
  const target = parseTarget(raw.target, filePath);
  // A targeted case's turns come from target.from on a bullpen thread; a sender would be ignored.
  if (target && raw.sender !== undefined) {
    throw new Error(`'sender' and 'target' cannot both be set in ${filePath} — a targeted case's turns come from target.from`);
  }
  if (!raw.turns || raw.turns.length === 0) throw new Error(`Missing 'turns' in ${filePath}`);
  if (!raw.expected_behaviors || raw.expected_behaviors.length === 0) {
    throw new Error(`Missing 'expected_behaviors' in ${filePath}`);
  }

  const turns: Turn[] = raw.turns.map((t, i) => {
    const unknownTurnKeys = Object.keys(t).filter(k => !TURN_KEYS.has(k));
    if (unknownTurnKeys.length > 0) {
      throw new Error(`Unknown key(s) ${unknownTurnKeys.map(k => `'${k}'`).join(', ')} in turn ${i} of ${filePath}`);
    }
    if (!t.content) throw new Error(`Turn ${i} missing 'content' in ${filePath}`);
    return {
      role: 'user' as const,
      content: t.content,
      delayMs: t.delay_ms,
      ...(t.tool_stubs !== undefined ? { toolStubs: parseStubs(t.tool_stubs, filePath) } : {}),
    };
  });

  // Duplicate ids would share the judge's first score and collapse in the gate's lookup,
  // so a critical MISS could hide behind a nice-to-have PASS of the same id.
  const ids = raw.expected_behaviors.map(b => b.id);
  const duplicate = ids.find((id, i) => id !== undefined && ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`Duplicate behavior id '${duplicate}' in ${filePath}`);

  const expectedBehaviors: ExpectedBehavior[] = raw.expected_behaviors.map((b, i) => {
    if (!b.id) throw new Error(`Behavior ${i} missing 'id' in ${filePath}`);
    if (!b.description) throw new Error(`Behavior ${i} missing 'description' in ${filePath}`);
    // Default weight to 'important' if not specified.
    const weight = (b.weight ?? 'important') as BehaviorWeight;
    if (!VALID_WEIGHTS.includes(weight)) {
      throw new Error(`Invalid weight '${b.weight}' for behavior '${b.id}' in ${filePath}`);
    }
    return { id: b.id, description: b.description, weight };
  });

  // Catch a malformed or misspelt placeholder at load time, not mid-run.
  try {
    assertResolvable([raw.tool_stubs, raw.turns.map(t => [t.content, t.tool_stubs]), target?.topic, target?.opening]);
  } catch (err) {
    throw new Error(`Bad placeholder in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    name: raw.name,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    sender: sender as SmokeSender,
    ...(target ? { target } : {}),
    judgeToolCalls: raw.judge_tool_calls === true,
    toolStubs: parseStubs(raw.tool_stubs, filePath),
    ...(knownFailure ? { knownFailure } : {}),
    turns,
    expectedBehaviors,
    failureModes: raw.failure_modes ?? [],
  };
}

/**
 * Resolve every placeholder in `value` against a stand-in principal and throw if any
 * `{{…}}` is left (other than `{{input:…}}`, filled per call). A misspelt kind —
 * `{{dat:today}}`, `{{principal:Name}}` — matches no resolver and would otherwise reach
 * the model as literal text, or make a stub `match` that never matches.
 */
function assertResolvable(value: unknown): void {
  const resolved = resolvePrincipalPlaceholders(
    resolveDatePlaceholders(value, 'UTC'),
    { name: 'Placeholder Check', contactId: '00000000-0000-0000-0000-000000000000' },
  );
  const leftover = JSON.stringify(resolved ?? null).match(/\{\{(?!\s*input:)[^}]*\}\}/);
  if (leftover) throw new Error(`unrecognised placeholder ${leftover[0]}`);
}

/** Targets naming an agent this stack does not run. Checked once the stack is up, before a paid run. */
export function targetProblems(cases: TestCase[], isAgent: (name: string) => boolean): string[] {
  return cases.flatMap(c => {
    const target = c.target;
    if (!target) return [];
    return (['agent', 'from'] as const)
      .filter(key => !isAgent(target[key]))
      .map(key => `${c.name}: target.${key} '${target[key]}' is not a registered agent`);
  });
}

/** The shared fixture world every case runs in (stubs/office.yaml), parsed and validated. */
export function loadDefaultStubs(filePath: string): Record<string, ToolStub[]> {
  const stubs = parseStubs(yaml.load(readFileSync(filePath, 'utf-8')), filePath);
  try {
    assertResolvable(stubs);
  } catch (err) {
    throw new Error(`Bad date placeholder in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return stubs;
}

/**
 * Load all YAML test cases from a directory.
 * Files are sorted alphabetically for a stable, predictable load order.
 * Optionally filter to only cases that have at least one of the given tags.
 * Throws if any two files share the same case name — duplicates would cause
 * the --case CLI filter to match multiple cases silently.
 */
export function loadTestCases(
  dirPath: string,
  options?: { tags?: string[] },
): TestCase[] {
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const cases = files.map(f => loadTestCase(path.join(dirPath, f)));

  // Enforce unique names before applying tag filtering so duplicates are caught
  // regardless of which tags are in use.
  // Normalize to lowercase so duplicate detection matches CLI --case filter semantics,
  // which uses case-insensitive substring matching (see cli.ts line 34).
  const seen = new Set<string>();
  for (const tc of cases) {
    const normalizedName = tc.name.trim().toLowerCase();
    if (seen.has(normalizedName)) {
      throw new Error(
        `Duplicate test case name '${tc.name}' found in ${dirPath} — each test case must have a unique name`,
      );
    }
    seen.add(normalizedName);
  }

  if (options?.tags && options.tags.length > 0) {
    const filterTags = new Set(options.tags);
    return cases.filter(tc => tc.tags.some(t => filterTags.has(t)));
  }

  return cases;
}

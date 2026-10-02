import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { parseStubs } from '../scenarios/loader.js';
import { resolveDatePlaceholders } from './date-placeholders.js';
import { SMOKE_SENDERS, type TestCase, type Turn, type ExpectedBehavior, type BehaviorWeight, type SmokeSender } from './types.js';

const VALID_WEIGHTS: BehaviorWeight[] = ['critical', 'important', 'nice-to-have'];

// Shape of the raw YAML before we normalize field names (snake_case → camelCase).
interface RawTestCase {
  name?: string;
  description?: string;
  tags?: string[];
  sender?: unknown;
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
  'name', 'description', 'tags', 'sender', 'judge_tool_calls', 'tool_stubs', 'known_failure',
  'turns', 'expected_behaviors', 'failure_modes',
]);
const TURN_KEYS: ReadonlySet<string> = new Set(['role', 'content', 'delay_ms', 'tool_stubs']);

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

  // Catch a malformed date placeholder at load time, not mid-run.
  try {
    resolveDatePlaceholders([raw.tool_stubs, raw.turns.map(t => t.tool_stubs)], 'UTC');
  } catch (err) {
    throw new Error(`Bad date placeholder in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    name: raw.name,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    sender: sender as SmokeSender,
    judgeToolCalls: raw.judge_tool_calls === true,
    toolStubs: parseStubs(raw.tool_stubs, filePath),
    ...(knownFailure ? { knownFailure } : {}),
    turns,
    expectedBehaviors,
    failureModes: raw.failure_modes ?? [],
  };
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

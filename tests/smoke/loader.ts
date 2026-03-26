import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { TestCase, Turn, ExpectedBehavior, BehaviorWeight } from './types.js';

const VALID_WEIGHTS: BehaviorWeight[] = ['critical', 'important', 'nice-to-have'];

// Shape of the raw YAML before we normalize field names (snake_case → camelCase).
interface RawTestCase {
  name?: string;
  description?: string;
  tags?: string[];
  turns?: Array<{ role?: string; content?: string; delay_ms?: number }>;
  expected_behaviors?: Array<{ id?: string; description?: string; weight?: string }>;
  failure_modes?: string[];
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
  if (!raw.name) throw new Error(`Missing 'name' in ${filePath}`);
  if (!raw.turns || raw.turns.length === 0) throw new Error(`Missing 'turns' in ${filePath}`);
  if (!raw.expected_behaviors || raw.expected_behaviors.length === 0) {
    throw new Error(`Missing 'expected_behaviors' in ${filePath}`);
  }

  const turns: Turn[] = raw.turns.map((t, i) => {
    if (!t.content) throw new Error(`Turn ${i} missing 'content' in ${filePath}`);
    return {
      role: 'user' as const,
      content: t.content,
      delayMs: t.delay_ms,
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

  return {
    name: raw.name,
    description: raw.description ?? '',
    tags: raw.tags ?? [],
    turns,
    expectedBehaviors,
    failureModes: raw.failure_modes ?? [],
  };
}

/**
 * Load all YAML test cases from a directory.
 * Files are sorted alphabetically for a stable, predictable load order.
 * Optionally filter to only cases that have at least one of the given tags.
 */
export function loadTestCases(
  dirPath: string,
  options?: { tags?: string[] },
): TestCase[] {
  const files = readdirSync(dirPath)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  let cases = files.map(f => loadTestCase(path.join(dirPath, f)));

  if (options?.tags && options.tags.length > 0) {
    const filterTags = new Set(options.tags);
    cases = cases.filter(tc => tc.tags.some(t => filterTags.has(t)));
  }

  return cases;
}

/**
 * ci.yml runs as parallel jobs gated by one `ci` job, the status check the main ruleset
 * requires. These pin the gate: it waits for every job that runs a check, it reports even
 * when one of them fails, and the test shards cover every file exactly once.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(import.meta.dirname, '../../..');

interface Step {
  name?: string;
  run?: string;
}

interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
  steps: Step[];
}

interface Workflow {
  jobs: Record<string, Job>;
}

const ci = yaml.load(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Workflow;

// Jobs outside the required check: image builds, which report as their own checks.
const NOT_GATED = new Set(['ci', 'postgres-image', 'changes', 'curia-image']);

describe('ci.yml shape', () => {
  it('gates the required `ci` check on every check job', () => {
    const gated = Object.keys(ci.jobs).filter((name) => !NOT_GATED.has(name));
    expect(gated.length).toBeGreaterThan(0);
    expect([...(ci.jobs.ci!.needs ?? [])].sort()).toEqual(gated.sort());
  });

  it('reports `ci` even when a gated job fails, and fails it then', () => {
    // Without an `if`, a failed need makes `ci` skipped, and a skipped required check
    // leaves the PR waiting forever instead of red.
    expect(ci.jobs.ci!.if).toBe('${{ !cancelled() }}');
    const run = ci.jobs.ci!.steps.map((s) => s.run ?? '').join('\n');
    expect(run).toMatch(/select\(\. != "success"\)/);
    expect(run).toContain('exit 1');
  });

  it('runs every test shard, and each shard names the same total', () => {
    const test = ci.jobs.test!;
    const shards = test.strategy?.matrix?.shard ?? [];
    expect(shards).toEqual(shards.map((_, i) => i + 1));
    expect(test.strategy?.['fail-fast']).toBe(false);
    const run = test.steps.find((s) => s.name === 'Run tests')?.run ?? '';
    // `--shard=i/N` with N the matrix size: a fourth shard added to the matrix but not
    // here would run a quarter of the files twice and skip none, and the reverse would
    // skip a third of them.
    expect(run).toBe(`pnpm test --shard=\${{ matrix.shard }}/${shards.length}`);
  });
});

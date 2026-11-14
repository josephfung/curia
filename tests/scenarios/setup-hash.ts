// tests/scenarios/setup-hash.ts — a fingerprint of what a case's agents saw (#2556).
//
// `pnpm rejudge --from-cases` re-scores saved transcripts against the expected behaviors in
// the current case files. That is sound only while the situation the transcript came from is
// unchanged: a case whose seed, inbound or stubs were edited since needs a new run, not a new
// score. Results record this hash per case, and re-scoring refuses a case whose hash moved.
//
// The hash covers everything that shapes a run: the agent reached, delegation, the seed, the
// inbound, every stub (the case's, its stub sets' and the defaults, as merged), live search,
// the identity and autonomy fixtures, gateway settings and the timeout. It leaves out the
// rubric, which only the judge and the checks read: expected behaviors, failure modes and the
// description (shown to the judge, never to the agents), plus bookkeeping (name, tags, runs,
// release_gate, known_failure, judge_model, the source file).
import { createHash } from 'node:crypto';
import type { ScenarioCase } from './types.js';

/** The parts of a case that shape its runs. */
export function caseSetup(scenario: ScenarioCase): Record<string, unknown> {
  return {
    agent: scenario.agent,
    delegation: scenario.delegation,
    timeoutSeconds: scenario.timeoutSeconds ?? null,
    seed: scenario.seed,
    inbound: scenario.inbound,
    toolStubs: scenario.toolStubs,
    liveSearch: scenario.liveSearch ?? false,
    identity: scenario.identity ? { name: scenario.identity.name, config: scenario.identity.config } : null,
    autonomy: scenario.autonomy ?? null,
    throughGateway: scenario.throughGateway ?? false,
    gatedTools: scenario.gatedTools ?? [],
  };
}

/** JSON with object keys sorted at every level, so key order in a YAML file cannot move the hash. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => stableStringify(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of the case's setup, first 16 hex digits: enough to tell edits apart, short enough to read. */
export function caseSetupHash(scenario: ScenarioCase): string {
  return createHash('sha256').update(stableStringify(caseSetup(scenario))).digest('hex').slice(0, 16);
}

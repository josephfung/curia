// Smoke's command line is parsed strictly (#1956).
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY } from '../../shared/case-scope.js';
import { parseSmokeArgs } from '../../smoke/args.js';

describe('parseSmokeArgs', () => {
  it('reads every flag', () => {
    expect(parseSmokeArgs(['--model', 'deepseek/x', '--case', 'a', '--case', 'b', '--tags', 'x, y', '--concurrency', '6', '--show-calls', '--allow-remote-db']))
      .toEqual({ model: 'deepseek/x', cases: ['a', 'b'], tags: ['x', 'y'], concurrency: 6, showCalls: true, allowRemoteDb: true });
  });

  it('defaults to the whole suite on the configured routing', () => {
    expect(parseSmokeArgs([])).toEqual({ cases: [], showCalls: false, allowRemoteDb: false, concurrency: DEFAULT_CONCURRENCY });
  });

  it('rejects --flag=value, so a release run cannot silently drop its --model', () => {
    expect(() => parseSmokeArgs(['--model=deepseek/x'])).toThrow(/--model <value>/);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseSmokeArgs(['--tag', 'calendar'])).toThrow(/unknown argument '--tag'/);
    expect(() => parseSmokeArgs(['--model'])).toThrow(/--model needs a value/);
    expect(() => parseSmokeArgs(['--case', '--show-calls'])).toThrow(/--case needs a value/);
    expect(() => parseSmokeArgs(['--model', 'a', '--model', 'b'])).toThrow(/twice/);
  });

  it('rejects a concurrency that is not a positive integer (#1980)', () => {
    expect(() => parseSmokeArgs(['--concurrency', '0'])).toThrow(/positive integer/);
    expect(() => parseSmokeArgs(['--concurrency', '2.5'])).toThrow(/positive integer/);
    expect(() => parseSmokeArgs(['--concurrency', '2', '--concurrency', '3'])).toThrow(/given twice/);
  });
});

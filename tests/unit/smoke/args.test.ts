// Smoke's command line is parsed strictly (#1956).
import { describe, expect, it } from 'vitest';
import { parseSmokeArgs } from '../../smoke/args.js';

describe('parseSmokeArgs', () => {
  it('reads every flag', () => {
    expect(parseSmokeArgs(['--model', 'deepseek/x', '--case', 'a', '--case', 'b', '--tags', 'x, y', '--show-calls', '--allow-remote-db']))
      .toEqual({ model: 'deepseek/x', cases: ['a', 'b'], tags: ['x', 'y'], showCalls: true, allowRemoteDb: true });
  });

  it('defaults to the whole suite on the configured routing', () => {
    expect(parseSmokeArgs([])).toEqual({ cases: [], showCalls: false, allowRemoteDb: false });
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
});

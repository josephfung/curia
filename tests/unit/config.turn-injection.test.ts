// dispatch.turnInjection (#2018, ADR-053). An absent field stays off. The shipped
// default.yaml turns the flag on. A bad block fails at boot: laneWaitTimeoutMs
// reaches setTimeout, and a zero cap would reject every follow-up while looking
// configured.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveTurnInjectionConfig } from '../../src/config.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-turn-injection-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveTurnInjectionConfig (#2018)', () => {
  it('stays off when the field is absent, with the ADR-053 §3 cap and the §6 fail-open', () => {
    expect(resolveTurnInjectionConfig(undefined)).toEqual({
      enabled: false,
      maxInjectionsPerTurn: 5,
      extraRoundsPerInjection: 2,
      laneWaitTimeoutMs: 1_200_000,
    });
  });

  it('applies an override field without dropping the others', () => {
    expect(resolveTurnInjectionConfig({ turnInjection: { enabled: true, maxInjectionsPerTurn: 3 } })).toEqual({
      enabled: true,
      maxInjectionsPerTurn: 3,
      extraRoundsPerInjection: 2,
      laneWaitTimeoutMs: 1_200_000,
    });
  });

  it('reads the shipped default.yaml with the flag on', () => {
    const config = loadYamlConfig(path.resolve(import.meta.dirname, '../../config'));
    expect(resolveTurnInjectionConfig(config.dispatch).enabled).toBe(true);
    expect(resolveTurnInjectionConfig(config.dispatch).maxInjectionsPerTurn).toBe(5);
  });

  it('lets local.yaml turn an enabled default off without dropping the other fields', () => {
    const dir = writeConfig(`
dispatch:
  turnInjection:
    enabled: true
    maxInjectionsPerTurn: 5
    extraRoundsPerInjection: 2
    laneWaitTimeoutMs: 1200000
`);
    fs.writeFileSync(path.join(dir, 'local.yaml'), `
dispatch:
  turnInjection:
    enabled: false
`);
    expect(resolveTurnInjectionConfig(loadYamlConfig(dir).dispatch)).toEqual({
      enabled: false,
      maxInjectionsPerTurn: 5,
      extraRoundsPerInjection: 2,
      laneWaitTimeoutMs: 1_200_000,
    });
  });
});

describe('loadYamlConfig — dispatch.turnInjection validation (#2018)', () => {
  it('accepts a well-formed block', () => {
    const dir = writeConfig(`
dispatch:
  turnInjection:
    enabled: true
    maxInjectionsPerTurn: 5
    extraRoundsPerInjection: 2
    laneWaitTimeoutMs: 1200000
`);
    expect(resolveTurnInjectionConfig(loadYamlConfig(dir).dispatch).enabled).toBe(true);
  });

  it('rejects a scalar where the mapping belongs', () => {
    const dir = writeConfig('dispatch:\n  turnInjection: true\n');
    expect(() => loadYamlConfig(dir)).toThrow(/turnInjection must be a YAML mapping/);
  });

  it('rejects a non-boolean enabled', () => {
    const dir = writeConfig('dispatch:\n  turnInjection:\n    enabled: "yes"\n');
    expect(() => loadYamlConfig(dir)).toThrow(/turnInjection.enabled must be a boolean/);
  });

  it('rejects a zero cap', () => {
    const dir = writeConfig('dispatch:\n  turnInjection:\n    maxInjectionsPerTurn: 0\n');
    expect(() => loadYamlConfig(dir)).toThrow(/maxInjectionsPerTurn must be a positive integer/);
  });

  it('rejects a fractional round allowance', () => {
    const dir = writeConfig('dispatch:\n  turnInjection:\n    extraRoundsPerInjection: 1.5\n');
    expect(() => loadYamlConfig(dir)).toThrow(/extraRoundsPerInjection must be a positive integer/);
  });

  it('rejects a timeout past the Node.js timer limit', () => {
    const dir = writeConfig('dispatch:\n  turnInjection:\n    laneWaitTimeoutMs: 2147483648\n');
    expect(() => loadYamlConfig(dir)).toThrow(/exceeds the Node.js timer limit/);
  });
});

// config.gating.test.ts — autonomy.gating resolution and validation (#2159).
//
// A typo in autonomy.gating must fail at boot rather than silently keep the tier gates
// (or, worse, silently switch the operator to a policy they did not choose).

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveAutonomyGating } from '../../src/config.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-gating-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveAutonomyGating (#2159)', () => {
  it('defaults to tier', () => {
    expect(resolveAutonomyGating(undefined)).toBe('tier');
    expect(resolveAutonomyGating({})).toBe('tier');
  });

  it('accepts band', () => {
    expect(resolveAutonomyGating({ gating: 'band' })).toBe('band');
  });
});

describe('loadYamlConfig — autonomy.gating validation (#2159)', () => {
  it('accepts band and tier', () => {
    expect(resolveAutonomyGating(loadYamlConfig(writeConfig('autonomy:\n  gating: band\n')).autonomy)).toBe('band');
    expect(resolveAutonomyGating(loadYamlConfig(writeConfig('autonomy:\n  gating: tier\n')).autonomy)).toBe('tier');
  });

  it('rejects anything else at load time', () => {
    expect(() => loadYamlConfig(writeConfig('autonomy:\n  gating: score\n')))
      .toThrow(/autonomy.gating must be one of band, tier/);
  });
});

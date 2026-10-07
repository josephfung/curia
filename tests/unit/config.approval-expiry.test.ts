// config.approval-expiry.test.ts — autonomy.approval_expiry resolution and validation (#2013).
//
// The interval reaches setInterval as minutes × 60000, so a zero, fractional or overflowed
// value must fail loudly at startup rather than spin the sweep in a tight loop.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveApprovalExpiryConfig } from '../../src/config.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-approval-expiry-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveApprovalExpiryConfig (#2013)', () => {
  it('defaults to an hourly sweep', () => {
    expect(resolveApprovalExpiryConfig(undefined)).toEqual({ sweepIntervalMinutes: 60 });
    expect(resolveApprovalExpiryConfig({ bypass_ladder: { same_task: 70 } })).toEqual({ sweepIntervalMinutes: 60 });
  });

  it('applies an override', () => {
    expect(resolveApprovalExpiryConfig({ approval_expiry: { sweep_interval_minutes: 15 } })).toEqual({
      sweepIntervalMinutes: 15,
    });
  });
});

describe('loadYamlConfig — autonomy.approval_expiry validation (#2013)', () => {
  it('accepts a well-formed block', () => {
    const dir = writeConfig('autonomy:\n  approval_expiry:\n    sweep_interval_minutes: 30\n');
    const config = loadYamlConfig(dir);
    expect(resolveApprovalExpiryConfig(config.autonomy).sweepIntervalMinutes).toBe(30);
  });

  it('rejects a scalar where the mapping belongs', () => {
    const dir = writeConfig('autonomy:\n  approval_expiry: 60\n');
    expect(() => loadYamlConfig(dir)).toThrow(/approval_expiry must be a YAML mapping/);
  });

  it('rejects a zero interval', () => {
    const dir = writeConfig('autonomy:\n  approval_expiry:\n    sweep_interval_minutes: 0\n');
    expect(() => loadYamlConfig(dir)).toThrow(/sweep_interval_minutes must be a positive integer/);
  });

  it('rejects a fractional interval', () => {
    const dir = writeConfig('autonomy:\n  approval_expiry:\n    sweep_interval_minutes: 1.5\n');
    expect(() => loadYamlConfig(dir)).toThrow(/sweep_interval_minutes must be a positive integer/);
  });

  it('rejects an interval past the Node.js timer limit', () => {
    const dir = writeConfig('autonomy:\n  approval_expiry:\n    sweep_interval_minutes: 100000\n');
    expect(() => loadYamlConfig(dir)).toThrow(/exceeds the Node.js timer limit/);
  });
});

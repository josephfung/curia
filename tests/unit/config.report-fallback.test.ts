// config.report-fallback.test.ts — autonomy.report_fallback resolution and validation (#2159).
//
// check_interval_hours reaches setInterval as hours × 3,600,000, so a zero, fractional or
// overflowed value must fail loudly at startup rather than spin the check in a tight loop.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveReportFallbackConfig } from '../../src/config.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-report-fallback-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveReportFallbackConfig (#2159)', () => {
  it('defaults to a daily check and a one-week threshold', () => {
    expect(resolveReportFallbackConfig(undefined)).toEqual({ maxAgeDays: 7, checkIntervalHours: 24 });
  });

  it('reads both values', () => {
    expect(resolveReportFallbackConfig({ report_fallback: { max_age_days: 3, check_interval_hours: 6 } }))
      .toEqual({ maxAgeDays: 3, checkIntervalHours: 6 });
  });
});

describe('loadYamlConfig — autonomy.report_fallback validation (#2159)', () => {
  it('accepts a well-formed block', () => {
    const dir = writeConfig('autonomy:\n  report_fallback:\n    max_age_days: 5\n    check_interval_hours: 12\n');
    expect(resolveReportFallbackConfig(loadYamlConfig(dir).autonomy)).toEqual({ maxAgeDays: 5, checkIntervalHours: 12 });
  });

  it('rejects a scalar where the mapping belongs', () => {
    const dir = writeConfig('autonomy:\n  report_fallback: 7\n');
    expect(() => loadYamlConfig(dir)).toThrow(/report_fallback must be a YAML mapping/);
  });

  it('rejects a zero or fractional value', () => {
    expect(() => loadYamlConfig(writeConfig('autonomy:\n  report_fallback:\n    max_age_days: 0\n')))
      .toThrow(/max_age_days must be a positive integer/);
    expect(() => loadYamlConfig(writeConfig('autonomy:\n  report_fallback:\n    check_interval_hours: 1.5\n')))
      .toThrow(/check_interval_hours must be a positive integer/);
  });

  it('rejects an interval past the Node.js timer limit', () => {
    const dir = writeConfig('autonomy:\n  report_fallback:\n    check_interval_hours: 100000\n');
    expect(() => loadYamlConfig(dir)).toThrow(/exceeds the Node.js timer limit/);
  });
});

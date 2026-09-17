// config.late-delivery.test.ts — delegate.lateDelivery resolution and validation (#1799).
//
// The kill switch matters most here: `enabled: false` must restore the pre-#1799 behaviour
// exactly, and a mis-shaped block must fail loudly at startup rather than silently dropping an
// operator's override (the failure mode delegate.defaultTimeoutMs's own guard exists for).

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig, resolveLateDeliveryConfig } from './config.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-late-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

describe('resolveLateDeliveryConfig (#1799)', () => {
  it('defaults to enabled with a one-hour TTL and five-minute sweep', () => {
    expect(resolveLateDeliveryConfig(undefined)).toEqual({
      enabled: true,
      ttlMinutes: 60,
      sweepIntervalMinutes: 5,
      maxResultChars: 8000,
    });
  });

  it('keeps defaults when only defaultTimeoutMs is configured', () => {
    expect(resolveLateDeliveryConfig({ defaultTimeoutMs: 120_000 }).enabled).toBe(true);
  });

  it('applies each override independently', () => {
    const resolved = resolveLateDeliveryConfig({
      lateDelivery: { ttlMinutes: 240, maxResultChars: 2000 },
    });
    expect(resolved.ttlMinutes).toBe(240);
    expect(resolved.maxResultChars).toBe(2000);
    expect(resolved.sweepIntervalMinutes).toBe(5);
    expect(resolved.enabled).toBe(true);
  });

  it('honours the kill switch', () => {
    expect(resolveLateDeliveryConfig({ lateDelivery: { enabled: false } }).enabled).toBe(false);
  });
});

describe('loadYamlConfig — delegate.lateDelivery validation (#1799)', () => {
  it('accepts a well-formed block', () => {
    const dir = writeConfig(`
delegate:
  defaultTimeoutMs: 90000
  lateDelivery:
    enabled: true
    ttlMinutes: 120
    sweepIntervalMinutes: 10
    maxResultChars: 4000
`);
    const config = loadYamlConfig(dir);
    expect(config.delegate?.lateDelivery?.ttlMinutes).toBe(120);
    expect(resolveLateDeliveryConfig(config.delegate).sweepIntervalMinutes).toBe(10);
  });

  it('rejects a scalar where the mapping belongs', () => {
    const dir = writeConfig('delegate:\n  lateDelivery: 60\n');
    expect(() => loadYamlConfig(dir)).toThrow(/lateDelivery must be a YAML mapping/);
  });

  it('rejects a non-boolean enabled', () => {
    const dir = writeConfig('delegate:\n  lateDelivery:\n    enabled: "yes"\n');
    expect(() => loadYamlConfig(dir)).toThrow(/enabled must be a boolean/);
  });

  for (const field of ['ttlMinutes', 'sweepIntervalMinutes', 'maxResultChars']) {
    it(`rejects a zero or negative ${field}`, () => {
      const dir = writeConfig(`delegate:\n  lateDelivery:\n    ${field}: 0\n`);
      expect(() => loadYamlConfig(dir)).toThrow(new RegExp(`${field} must be a positive integer`));
    });

    it(`rejects a fractional ${field}`, () => {
      const dir = writeConfig(`delegate:\n  lateDelivery:\n    ${field}: 1.5\n`);
      expect(() => loadYamlConfig(dir)).toThrow(new RegExp(`${field} must be a positive integer`));
    });
  }
});

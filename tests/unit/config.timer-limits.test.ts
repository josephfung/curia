// config.timer-limits.test.ts — operator-set intervals must fit a Node timer (#1807).
//
// Node stores a timer delay in a signed 32-bit int. Past 2^31-1 ms setInterval silently
// truncates and fires almost immediately, forever — so raising an interval to slow a
// background pass down yields the fastest possible pass, with nothing in the logs saying
// why. Every key below reaches setTimeout/setInterval, so each carries a ceiling.
//
// The boundary is what matters: at the limit must be accepted, one above must be rejected.
// A test that only feeds "a big number" would pass against an off-by-one ceiling.

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadYamlConfig } from '../../src/config.js';

const NODE_MAX_TIMER_MS = 2_147_483_647;
const NODE_MAX_TIMER_MINUTES = 35791; // Math.floor(NODE_MAX_TIMER_MS / 60_000)

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(defaultYaml: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curia-timer-cfg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'default.yaml'), defaultYaml);
  return dir;
}

// Every config key whose value reaches a Node timer, with the ceiling expressed in that
// key's own unit. The two delegate keys were guarded before #1807 and are covered here so
// the move onto the shared helper cannot regress them.
const TIMER_KEYS: Array<{ key: string; max: number; unit: string; yaml: (value: number) => string }> = [
  {
    key: 'tasks.heartbeatIntervalMinutes',
    max: NODE_MAX_TIMER_MINUTES,
    unit: 'minutes',
    yaml: (v) => `tasks:\n  heartbeatIntervalMinutes: ${v}\n`,
  },
  {
    key: 'dreaming.decay.intervalMs',
    max: NODE_MAX_TIMER_MS,
    unit: 'ms',
    yaml: (v) => `dreaming:\n  decay:\n    intervalMs: ${v}\n`,
  },
  {
    key: 'dreaming.autonomy_scoring.intervalMs',
    max: NODE_MAX_TIMER_MS,
    unit: 'ms',
    yaml: (v) => `dreaming:\n  autonomy_scoring:\n    intervalMs: ${v}\n`,
  },
  {
    key: 'browser.sweepIntervalMs',
    max: NODE_MAX_TIMER_MS,
    unit: 'ms',
    yaml: (v) => `browser:\n  sweepIntervalMs: ${v}\n`,
  },
  {
    key: 'delegate.defaultTimeoutMs',
    max: NODE_MAX_TIMER_MS,
    unit: 'ms',
    yaml: (v) => `delegate:\n  defaultTimeoutMs: ${v}\n`,
  },
  {
    key: 'delegate.lateDelivery.sweepIntervalMinutes',
    max: NODE_MAX_TIMER_MINUTES,
    unit: 'minutes',
    yaml: (v) => `delegate:\n  lateDelivery:\n    sweepIntervalMinutes: ${v}\n`,
  },
];

describe('loadYamlConfig — Node timer ceilings (#1807)', () => {
  for (const { key, max, unit, yaml } of TIMER_KEYS) {
    it(`accepts ${key} exactly at the limit`, () => {
      expect(() => loadYamlConfig(writeConfig(yaml(max)))).not.toThrow();
    });

    it(`rejects ${key} one above the limit, naming the key and the ceiling`, () => {
      const dir = writeConfig(yaml(max + 1));
      expect(() => loadYamlConfig(dir)).toThrow(
        new RegExp(`${key.replace(/\./g, '\\.')} exceeds the Node\\.js timer limit \\(${max} ${unit}\\)`),
      );
    });
  }

  // Regression guard for the acceptance criterion "no new ceiling on keys that feed date
  // arithmetic rather than timers" — these are compared against elapsed time or interpolated
  // into SQL intervals, so an absurd value is an operator's business, not an overflow.
  const NON_TIMER_YAML: Array<[string, string]> = [
    ['tasks.idleThresholdHours', 'tasks:\n  idleThresholdHours: 99999999\n'],
    ['tasks.staleWaitThresholdHours', 'tasks:\n  staleWaitThresholdHours: 99999999\n'],
    ['tasks.resumableContinuationSeconds', 'tasks:\n  resumableContinuationSeconds: 99999999999\n'],
    ['delegate.lateDelivery.ttlMinutes', 'delegate:\n  lateDelivery:\n    ttlMinutes: 99999999999\n'],
    ['browser.sessionTtlMs', 'browser:\n  sessionTtlMs: 99999999999\n'],
  ];

  for (const [key, yaml] of NON_TIMER_YAML) {
    it(`leaves ${key} unbounded — it feeds date arithmetic, not a timer`, () => {
      expect(() => loadYamlConfig(writeConfig(yaml))).not.toThrow();
    });
  }

  // In-range values must still load unchanged: the guard is an upper bound, not a rewrite.
  it('leaves in-range values untouched', () => {
    const dir = writeConfig(`
browser:
  sweepIntervalMs: 120000
dreaming:
  decay:
    intervalMs: 86400000
  autonomy_scoring:
    intervalMs: 86400000
tasks:
  heartbeatIntervalMinutes: 60
delegate:
  defaultTimeoutMs: 90000
  lateDelivery:
    sweepIntervalMinutes: 5
`);
    const config = loadYamlConfig(dir);
    expect(config.browser?.sweepIntervalMs).toBe(120_000);
    expect(config.dreaming?.decay?.intervalMs).toBe(86_400_000);
    expect(config.dreaming?.autonomy_scoring?.intervalMs).toBe(86_400_000);
    expect(config.tasks?.heartbeatIntervalMinutes).toBe(60);
    expect(config.delegate?.defaultTimeoutMs).toBe(90_000);
    expect(config.delegate?.lateDelivery?.sweepIntervalMinutes).toBe(5);
  });
});

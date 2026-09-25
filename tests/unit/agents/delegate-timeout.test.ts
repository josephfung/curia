import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { loadAllAgentConfigs } from '../../../src/agents/loader.js';
import {
  computeDelegateTimeoutMs,
  clampDelegateWaitTimeoutMs,
  DELEGATE_SKILL_OUTER_TIMEOUT_MS,
  DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS,
  DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS,
  isDelegateDefaultBelowFloor,
} from '../../../src/agents/delegate-timeout.js';

describe('computeDelegateTimeoutMs', () => {
  it('matches skills/delegate/tool.json outer timeout', () => {
    const manifestPath = join(import.meta.dirname, '../../../skills/delegate/tool.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { timeout: number };
    expect(DELEGATE_SKILL_OUTER_TIMEOUT_MS).toBe(manifest.timeout);
  });

  it('adds 25% headroom capped at three minutes', () => {
    expect(computeDelegateTimeoutMs(600)).toBe(750_000);
    expect(computeDelegateTimeoutMs(360)).toBe(450_000);
    expect(computeDelegateTimeoutMs(120)).toBe(150_000);
  });

  it('caps headroom at three minutes for long expected durations', () => {
    // 0.25 * 3000 = 750s of headroom, which exceeds the 180s cap.
    expect(computeDelegateTimeoutMs(3000)).toBe(DELEGATE_SKILL_OUTER_TIMEOUT_MS - DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS);
  });

  it('clamps wait timeout below delegate skill outer timeout with margin', () => {
    const clamped = DELEGATE_SKILL_OUTER_TIMEOUT_MS - DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS;
    // 800 + 180 = 980s would exceed the 900s outer skill budget.
    expect(computeDelegateTimeoutMs(800)).toBe(clamped);
    // 720 + 180 = 900s exactly — must still stay below the outer timeout.
    expect(computeDelegateTimeoutMs(720)).toBe(clamped);
  });

  it('covers representative reconciliation duration with a 10-minute expected hint', () => {
    const nineMinutesMs = 9 * 60 * 1000;
    expect(computeDelegateTimeoutMs(600)).toBeGreaterThanOrEqual(nineMinutesMs);
  });

  it('rejects invalid duration hints', () => {
    expect(() => computeDelegateTimeoutMs(0)).toThrow(RangeError);
    expect(() => computeDelegateTimeoutMs(-1)).toThrow(RangeError);
    expect(() => computeDelegateTimeoutMs(Number.NaN)).toThrow(RangeError);
  });
});

describe('clampDelegateWaitTimeoutMs', () => {
  it('passes through values below the outer timeout margin', () => {
    expect(clampDelegateWaitTimeoutMs(750_000)).toBe(750_000);
  });

  it('rejects non-positive values', () => {
    expect(() => clampDelegateWaitTimeoutMs(0)).toThrow(RangeError);
  });
});

/**
 * Clean-baseline p99 (ms) from the 1,550 delegate runs before 2026-09-20.
 * #1873 confirmed that window as the sizing basis. (#1857)
 */
const CLEAN_BASELINE_P99_MS = {
  calendar: 356_000,
  'ceo-inbox': 280_000,
  'research-analyst': 293_000,
  'meeting-debrief': 258_000,
  // Declared in curia-deploy custom/agents, not this repo.
  'writing-scout': 576_000,
  'social-media': 396_000,
} as const;

/** Hints #1857 specifies for the two deployment-repo agents. */
const DEPLOY_AGENT_HINT_SECONDS = {
  'writing-scout': 480,
  'social-media': 320,
} as const;

const CLAMP_CEILING_MS = DELEGATE_SKILL_OUTER_TIMEOUT_MS - DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS;

describe('delegate wait sizing (#1857)', () => {
  const agentsDir = join(import.meta.dirname, '../../../agents');
  const configDir = join(import.meta.dirname, '../../../config');

  it('flags an explicit fallback wait under the pooled-p99 floor', () => {
    expect(isDelegateDefaultBelowFloor(undefined)).toBe(false);
    expect(isDelegateDefaultBelowFloor(240_000)).toBe(true);
    expect(isDelegateDefaultBelowFloor(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS)).toBe(false);
    expect(isDelegateDefaultBelowFloor(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS + 1)).toBe(false);
  });

  it('ships defaultTimeoutMs at the pooled-p99 floor', () => {
    // Read default.yaml only. loadYamlConfig merges local.yaml, so a deployment
    // override of 240000 would fail this assertion of the shipped floor.
    const parsed = yaml.load(readFileSync(join(configDir, 'default.yaml'), 'utf8'));
    const timeoutMs = parsed !== null && typeof parsed === 'object' && 'delegate' in parsed
      ? (parsed as { delegate?: { defaultTimeoutMs?: number } }).delegate?.defaultTimeoutMs
      : undefined;
    expect(timeoutMs).toBe(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS);
    // Pooled p99 was 444s. The floor is that figure, rounded up.
    expect(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS).toBeGreaterThanOrEqual(444_000);
    expect(clampDelegateWaitTimeoutMs(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS)).toBeLessThanOrEqual(CLAMP_CEILING_MS);
  });

  it('resolves every shipped agent at or under the clamp ceiling', () => {
    const configs = loadAllAgentConfigs(agentsDir);
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      const wait = config.expected_duration_seconds !== undefined
        ? computeDelegateTimeoutMs(config.expected_duration_seconds)
        : clampDelegateWaitTimeoutMs(DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS);
      expect(wait, config.name).toBeLessThanOrEqual(CLAMP_CEILING_MS);
      expect(wait, config.name).toBeGreaterThan(0);
    }
  });

  it('clears measured p99 for core specialists that declare a hint', () => {
    const byName = new Map(loadAllAgentConfigs(agentsDir).map((config) => [config.name, config]));
    for (const name of ['calendar', 'ceo-inbox', 'research-analyst', 'meeting-debrief'] as const) {
      const hint = byName.get(name)?.expected_duration_seconds;
      expect(hint, name).toEqual(expect.any(Number));
      const wait = computeDelegateTimeoutMs(hint!);
      expect(wait, name).toBeGreaterThanOrEqual(CLEAN_BASELINE_P99_MS[name]);
      expect(wait, name).toBeLessThanOrEqual(CLAMP_CEILING_MS);
    }
  });

  // Neither agent ships in this repo. This locks the arithmetic those
  // curia-deploy hints must satisfy; it cannot catch a YAML regression here.
  it('documents the curia-deploy hint arithmetic (#1857)', () => {
    const byName = new Map(loadAllAgentConfigs(agentsDir).map((config) => [config.name, config]));
    for (const name of ['writing-scout', 'social-media'] as const) {
      const shipped = byName.get(name)?.expected_duration_seconds;
      const hint = shipped ?? DEPLOY_AGENT_HINT_SECONDS[name];
      const wait = computeDelegateTimeoutMs(hint);
      expect(wait, name).toBeGreaterThanOrEqual(CLEAN_BASELINE_P99_MS[name]);
      expect(wait, name).toBeLessThanOrEqual(CLAMP_CEILING_MS);
    }
  });
});

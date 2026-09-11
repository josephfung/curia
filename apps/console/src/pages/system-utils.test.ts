import { describe, it, expect } from 'vitest';
import {
  RESTART_TIMEOUT_MS,
  isSystemInfo,
  parseSystemPollResponse,
  evaluateRestartPoll,
  elapsedSeconds,
  formatRestartSuccess,
  restartPollRemainingMs,
  type SystemInfo,
} from './system-utils.js';

const SNAPSHOT: SystemInfo = {
  version: '0.42.0',
  nodeVersion: 'v24.14.0',
  timezone: 'America/Toronto',
  bootedAt: '2026-09-10T12:00:00.000Z',
  models: {
    defaultTier: 'standard',
    tiers: [{ tier: 'standard', model: 'claude-sonnet-4-6' }],
  },
};

const NEW_SNAPSHOT: SystemInfo = {
  ...SNAPSHOT,
  bootedAt: '2026-09-10T12:01:30.000Z',
};

describe('isSystemInfo', () => {
  it('accepts a well-formed snapshot', () => {
    expect(isSystemInfo(SNAPSHOT)).toBe(true);
  });

  it('rejects a missing bootedAt', () => {
    expect(isSystemInfo({
      version: SNAPSHOT.version,
      nodeVersion: SNAPSHOT.nodeVersion,
      timezone: SNAPSHOT.timezone,
      models: SNAPSHOT.models,
    })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isSystemInfo(null)).toBe(false);
    expect(isSystemInfo('nope')).toBe(false);
  });
});

describe('parseSystemPollResponse', () => {
  it('returns ok for a 200 with a valid system payload', () => {
    expect(parseSystemPollResponse(200, { system: SNAPSHOT })).toEqual({
      kind: 'ok',
      snapshot: SNAPSHOT,
    });
  });

  it('returns malformed for a 200 whose body is not a system snapshot', () => {
    expect(parseSystemPollResponse(200, { system: { version: 'x' } })).toEqual({
      kind: 'malformed',
    });
    expect(parseSystemPollResponse(200, '<html></html>')).toEqual({ kind: 'malformed' });
  });

  it('returns http_error for non-200 (including 401/502 during the window)', () => {
    expect(parseSystemPollResponse(502, {})).toEqual({ kind: 'http_error', status: 502 });
    expect(parseSystemPollResponse(401, { error: 'Unauthorized' })).toEqual({
      kind: 'http_error',
      status: 401,
    });
  });
});

describe('evaluateRestartPoll', () => {
  const base = {
    previousBootedAt: SNAPSHOT.bootedAt,
    startedAtMs: 1_000,
    timeoutMs: RESTART_TIMEOUT_MS,
  };

  it('succeeds when a 200 carries a different bootedAt', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: 5_000,
      fetch: { kind: 'ok', snapshot: NEW_SNAPSHOT },
    });
    expect(decision).toEqual({ kind: 'succeeded', snapshot: NEW_SNAPSHOT });
  });

  it('continues when the old process still answers with the same bootedAt', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: 5_000,
      fetch: { kind: 'ok', snapshot: SNAPSHOT },
    });
    expect(decision).toEqual({ kind: 'continue' });
  });

  it('continues on transport errors (server is down — expected, not a failure)', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: 10_000,
      fetch: { kind: 'transport_error' },
    });
    expect(decision).toEqual({ kind: 'continue' });
  });

  it('continues on HTTP errors and malformed bodies during the window', () => {
    expect(evaluateRestartPoll({
      ...base,
      nowMs: 10_000,
      fetch: { kind: 'http_error', status: 502 },
    })).toEqual({ kind: 'continue' });
    expect(evaluateRestartPoll({
      ...base,
      nowMs: 10_000,
      fetch: { kind: 'malformed' },
    })).toEqual({ kind: 'continue' });
  });

  it('times out when the ceiling is reached without a new bootedAt', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: base.startedAtMs + RESTART_TIMEOUT_MS,
      fetch: { kind: 'transport_error' },
    });
    expect(decision).toEqual({ kind: 'timeout' });
  });

  it('times out on a same-bootedAt 200 at the ceiling (old process still up)', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: base.startedAtMs + RESTART_TIMEOUT_MS,
      fetch: { kind: 'ok', snapshot: SNAPSHOT },
    });
    expect(decision).toEqual({ kind: 'timeout' });
  });

  it('still succeeds if the new snapshot arrives exactly at the ceiling', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: base.startedAtMs + RESTART_TIMEOUT_MS,
      fetch: { kind: 'ok', snapshot: NEW_SNAPSHOT },
    });
    expect(decision).toEqual({ kind: 'succeeded', snapshot: NEW_SNAPSHOT });
  });

  it('continues one millisecond under the ceiling', () => {
    const decision = evaluateRestartPoll({
      ...base,
      nowMs: base.startedAtMs + RESTART_TIMEOUT_MS - 1,
      fetch: { kind: 'transport_error' },
    });
    expect(decision).toEqual({ kind: 'continue' });
  });
});

describe('elapsedSeconds / formatRestartSuccess', () => {
  it('floors elapsed milliseconds to whole seconds', () => {
    expect(elapsedSeconds(0, 1_999)).toBe(1);
    expect(elapsedSeconds(0, 0)).toBe(0);
  });

  it('never reports a negative elapsed', () => {
    expect(elapsedSeconds(5_000, 4_000)).toBe(0);
  });

  it('formats the success copy with a whole-second count, minimum 1', () => {
    expect(formatRestartSuccess(12_400)).toBe('Restarted, back up in 12s');
    expect(formatRestartSuccess(200)).toBe('Restarted, back up in 1s');
  });
});

describe('restartPollRemainingMs', () => {
  it('returns the unused portion of the ceiling', () => {
    expect(restartPollRemainingMs(1_000, 4_000, 10_000)).toBe(7_000);
  });

  it('clamps to 0 once the ceiling is reached', () => {
    expect(restartPollRemainingMs(1_000, 11_000, 10_000)).toBe(0);
    expect(restartPollRemainingMs(1_000, 12_000, 10_000)).toBe(0);
  });
});

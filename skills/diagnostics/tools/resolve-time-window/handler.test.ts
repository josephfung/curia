// skills/diagnostics/tools/resolve-time-window/handler.test.ts
//
// Pure-computation tests for the diagnostics time-window resolver (#1592).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResolveTimeWindowHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { DateTime, Settings } from 'luxon';
import pino from 'pino';

/** Mirror of audit-query's since/until validator — emitted values must pass it. */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function makeCtx(input: Record<string, unknown>, timezone = 'America/Toronto'): ToolContext {
  return {
    input,
    timezone,
    log: pino({ level: 'silent' }),
  } as unknown as ToolContext;
}

function expectAuditIso(value: unknown): asserts value is string {
  expect(typeof value).toBe('string');
  expect(value).toMatch(ISO_DATETIME_RE);
  expect(Number.isNaN(new Date(value as string).getTime())).toBe(false);
}

const handler = new ResolveTimeWindowHandler();

describe('ResolveTimeWindowHandler', () => {
  // Fixed "now": Mon Jul 27, 2026 11:44 AM EDT (America/Toronto, UTC-4).
  const fixedMs = DateTime.fromISO('2026-07-27T11:44:00', { zone: 'America/Toronto' }).toMillis();

  beforeEach(() => {
    Settings.now = () => fixedMs;
  });

  afterEach(() => {
    Settings.now = () => Date.now();
  });

  it('returns error when expression is missing', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/expression/i);
      expect(result.error).toMatch(/supported forms/i);
    }
  });

  it('returns error for unparseable input with supported forms', async () => {
    const result = await handler.execute(makeCtx({ expression: 'not a time at all xyzzy' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/could not parse/i);
      expect(result.error).toMatch(/supported forms/i);
    }
  });

  it('returns error for non-positive default_window_minutes', async () => {
    const result = await handler.execute(
      makeCtx({ expression: 'around 11:44am', default_window_minutes: 0 }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/default_window_minutes/i);
  });

  it('resolves a point-in-time expression to ±30 minutes by default', async () => {
    const result = await handler.execute(makeCtx({ expression: 'around 11:44am' }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-27T11:14:00-04:00');
    expect(data.until).toBe('2026-07-27T12:14:00-04:00');
    expect(data.interpretation).toMatch(/11:14\s*AM/i);
    expect(data.interpretation).toMatch(/12:14\s*PM/i);
    expect(typeof data.displayTimezone).toBe('string');
    expect(data.displayTimezone).toMatch(/UTC/);
  });

  it('honors custom default_window_minutes for point-in-time', async () => {
    const result = await handler.execute(
      makeCtx({ expression: 'around 11:44am', default_window_minutes: 15 }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-27T11:29:00-04:00');
    expect(data.until).toBe('2026-07-27T11:59:00-04:00');
  });

  it('resolves an explicit range to the stated bounds', async () => {
    const result = await handler.execute(makeCtx({ expression: '8-9am yesterday' }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-26T08:00:00-04:00');
    expect(data.until).toBe('2026-07-26T09:00:00-04:00');
    expect(data.interpretation).toMatch(/8:00\s*AM/i);
    expect(data.interpretation).toMatch(/9:00\s*AM/i);
  });

  it('resolves a whole-day expression to start-of-day through end-of-day', async () => {
    const result = await handler.execute(makeCtx({ expression: 'yesterday' }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-26T00:00:00-04:00');
    expect(data.until).toBe('2026-07-26T23:59:59-04:00');
  });

  it('resolves last Tuesday as a whole local day', async () => {
    // Fixed now is Monday Jul 27 → last Tuesday is Jul 21.
    const result = await handler.execute(makeCtx({ expression: 'last Tuesday' }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-21T00:00:00-04:00');
    expect(data.until).toBe('2026-07-21T23:59:59-04:00');
  });

  it('resolves "last 2 hours" as [now-2h, now]', async () => {
    const result = await handler.execute(makeCtx({ expression: 'last 2 hours' }));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    expect(data.since).toBe('2026-07-27T09:44:00-04:00');
    expect(data.until).toBe('2026-07-27T11:44:00-04:00');
  });

  it('emits DST-correct offsets for the same wall clock in winter vs summer', async () => {
    // Summer (EDT, UTC-4) — already fixed above.
    const summer = await handler.execute(makeCtx({ expression: 'around 11:44am' }));
    expect(summer.success).toBe(true);
    if (!summer.success) return;
    const summerData = summer.data as Record<string, unknown>;
    expect(summerData.since).toBe('2026-07-27T11:14:00-04:00');

    // Winter (EST, UTC-5): Thu Jan 15, 2026 11:44 AM.
    const winterMs = DateTime.fromISO('2026-01-15T11:44:00', { zone: 'America/Toronto' }).toMillis();
    Settings.now = () => winterMs;

    const winter = await handler.execute(makeCtx({ expression: 'around 11:44am' }));
    expect(winter.success).toBe(true);
    if (!winter.success) return;
    const winterData = winter.data as Record<string, unknown>;
    expectAuditIso(winterData.since);
    expectAuditIso(winterData.until);
    expect(winterData.since).toBe('2026-01-15T11:14:00-05:00');
    expect(winterData.until).toBe('2026-01-15T12:14:00-05:00');
  });

  it('falls back to UTC when timezone is not configured', async () => {
    const ctx = makeCtx({ expression: 'around 11:44am' });
    (ctx as unknown as Record<string, unknown>).timezone = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const data = result.data as Record<string, unknown>;
    expectAuditIso(data.since);
    expectAuditIso(data.until);
    // Without ctx.timezone, wall-clock "11:44am" is interpreted in UTC.
    expect(data.since).toBe('2026-07-27T11:14:00+00:00');
    expect(data.until).toBe('2026-07-27T12:14:00+00:00');
    expect(data.displayTimezone).toBeNull();
  });
});

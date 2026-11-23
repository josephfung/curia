// The operator's confirmation notice (#2710): owed, attempted, recorded, retried.
//
// Saving an operator address cannot always send the notice — "Who it's for" is the first Setup
// step on an install with no email account yet. So the notice is owed rather than fired and
// forgotten, and `operator_confirmation` makes the state visible. These tests pin the four states
// and the retry rules the console and Setup rely on.
import { describe, it, expect, vi } from 'vitest';
import {
  confirmationStatus,
  markOperatorConfirmationUndelivered,
  sendPendingOperatorConfirmation,
  type PendingConfirmationDeps,
} from '../../../src/notifications/operator-confirmation.js';
import { createSilentLogger } from '../../../src/logger.js';
import type { OperatorConfirmation, OperatorSetting } from '../../../src/settings/registry.js';

const OPERATOR: OperatorSetting = { name: 'Sam Rivera', email: 'sam@example.com' };
const OTHER: OperatorSetting = { name: 'Alex Doe', email: 'alex@example.com' };
const NOW = '2026-11-22T12:00:00.000Z';

function confirmation(overrides: Partial<OperatorConfirmation> = {}): OperatorConfirmation {
  return { email: OPERATOR.email, attemptedAt: NOW, sentAt: NOW, ...overrides };
}

describe('confirmationStatus', () => {
  it('is none with no operator: nothing is owed', () => {
    expect(confirmationStatus(undefined, undefined)).toEqual({ state: 'none' });
  });

  it('is pending when the address has never been attempted', () => {
    expect(confirmationStatus(OPERATOR, undefined))
      .toEqual({ state: 'pending', email: OPERATOR.email });
  });

  it('is pending when the address changed since the last attempt', () => {
    // A new EA's address is owed a notice even though the last one went out.
    expect(confirmationStatus(OPERATOR, confirmation({ email: OTHER.email })).state).toBe('pending');
  });

  it('is sent when the last attempt for this address was published', () => {
    expect(confirmationStatus(OPERATOR, confirmation()))
      .toEqual({ state: 'sent', email: OPERATOR.email, attemptedAt: NOW, sentAt: NOW });
  });

  it('is failed when the last attempt for this address reached nobody', () => {
    expect(confirmationStatus(OPERATOR, confirmation({ sentAt: null })))
      .toEqual({ state: 'failed', email: OPERATOR.email, attemptedAt: NOW });
  });
});

// ---------------------------------------------------------------------------
// Sending the owed notice
// ---------------------------------------------------------------------------

/** A settings store holding just these keys, and a gateway spy. */
function makeHarness(initial: { operator?: OperatorSetting; confirmation?: OperatorConfirmation }) {
  let operator = initial.operator;
  let stored = initial.confirmation;
  const sendNotification = vi.fn().mockResolvedValue('sent');

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT value FROM settings')) {
        const key = params![0];
        const value = key === 'operator' ? operator : key === 'operator_confirmation' ? stored : undefined;
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.includes('INSERT INTO settings_history')) return { rows: [] };
      if (sql.includes('INSERT INTO settings')) {
        const key = params![0] as string;
        const value = JSON.parse(String(params![1]));
        if (key === 'operator') operator = value;
        if (key === 'operator_confirmation') stored = value;
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM settings')) {
        operator = undefined;
        return { rows: [] };
      }
      throw new Error(`unexpected client SQL: ${sql}`);
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM settings WHERE key = ANY')) {
        const rows: Array<Record<string, unknown>> = [];
        if (operator) rows.push({ key: 'operator', value: operator, updated_by: 'console' });
        if (stored) rows.push({ key: 'operator_confirmation', value: stored, updated_by: 'curia' });
        return { rows };
      }
      return { rows: [] };
    }),
  };

  const deps: PendingConfirmationDeps = {
    pool: pool as never,
    gateway: { publishNotification: sendNotification },
    logger: createSilentLogger(),
  };
  return { deps, sendNotification, stored: () => stored };
}

describe('sendPendingOperatorConfirmation', () => {
  it('sends and records a pending notice', async () => {
    const h = makeHarness({ operator: OPERATOR });
    const status = await sendPendingOperatorConfirmation(h.deps);

    expect(status.state).toBe('sent');
    expect(h.sendNotification).toHaveBeenCalledOnce();
    expect(h.sendNotification.mock.calls[0]![0]).toMatchObject({ notificationType: 'operator_configured' });
    expect(h.stored()).toMatchObject({ email: OPERATOR.email, sentAt: expect.any(String) });
  });

  it('sends nothing when the notice for this address was already published', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation() });
    const status = await sendPendingOperatorConfirmation(h.deps);
    expect(status.state).toBe('sent');
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it('retries a failed attempt', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation({ sentAt: null }) });
    const status = await sendPendingOperatorConfirmation(h.deps);
    expect(status.state).toBe('sent');
    expect(h.sendNotification).toHaveBeenCalledOnce();
    expect(h.stored()).toMatchObject({ sentAt: expect.any(String) });
  });

  it('records a failed attempt and leaves the notice owed', async () => {
    const h = makeHarness({ operator: OPERATOR });
    h.sendNotification.mockResolvedValue('not_sent');
    const status = await sendPendingOperatorConfirmation(h.deps);
    expect(status.state).toBe('failed');
    expect(h.stored()).toMatchObject({ email: OPERATOR.email, sentAt: null });
  });

  it('keeps a queued notice owed: queued is not sent (#2710 review)', async () => {
    // A transient provider failure queued the notice. Its flush can fail until the row expires,
    // and nothing would correct a `sent` recorded now, so the confirmation stays failed and owed.
    const h = makeHarness({ operator: OPERATOR });
    h.sendNotification.mockResolvedValue('queued');
    const status = await sendPendingOperatorConfirmation(h.deps);
    expect(status.state).toBe('failed');
    expect(h.stored()).toMatchObject({ email: OPERATOR.email, sentAt: null });

    // The next attempt that is dispatched records it sent.
    h.sendNotification.mockResolvedValue('sent');
    expect((await sendPendingOperatorConfirmation(h.deps)).state).toBe('sent');
  });

  it('does not attempt, and records nothing, when nothing can deliver it yet', async () => {
    // The first Setup step on a fresh install: no email adapter, so the notice is owed, not failed.
    const h = makeHarness({ operator: OPERATOR });
    const status = await sendPendingOperatorConfirmation({ ...h.deps, canDeliver: () => false });
    expect(status.state).toBe('pending');
    expect(h.sendNotification).not.toHaveBeenCalled();
    expect(h.stored()).toBeUndefined();
  });

  it('does not attempt with no gateway, and still reports pending', async () => {
    const h = makeHarness({ operator: OPERATOR });
    // No gateway at all: nothing can be sent, so the notice is owed and nothing is recorded.
    const withoutGateway = { pool: h.deps.pool, logger: h.deps.logger };
    expect(await sendPendingOperatorConfirmation(withoutGateway)).toMatchObject({ state: 'pending' });
    expect(h.stored()).toBeUndefined();
  });

  it('does nothing when no operator is set', async () => {
    const h = makeHarness({});
    expect(await sendPendingOperatorConfirmation(h.deps)).toEqual({ state: 'none' });
    expect(h.sendNotification).not.toHaveBeenCalled();
  });

  it('sends to a changed address even when the previous one was confirmed', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation({ email: OTHER.email }) });
    expect(await sendPendingOperatorConfirmation(h.deps)).toMatchObject({ state: 'sent', email: OPERATOR.email });
    expect(h.sendNotification).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// A published notice that the adapter could not deliver (#2710 review)
// ---------------------------------------------------------------------------

describe('markOperatorConfirmationUndelivered', () => {
  it('puts a "sent" confirmation back to failed, so the console stops claiming it arrived', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation() });
    await markOperatorConfirmationUndelivered({ pool: h.deps.pool, logger: h.deps.logger, recipient: OPERATOR.email });

    expect(h.stored()).toMatchObject({ email: OPERATOR.email, sentAt: null, attemptedAt: NOW });
    await expect(sendPendingOperatorConfirmation(h.deps)).resolves.toMatchObject({ state: 'sent' });
    expect(h.sendNotification).toHaveBeenCalledOnce();
  });

  it('leaves a failure record alone when nothing says it was sent', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation({ sentAt: null }) });
    await markOperatorConfirmationUndelivered({ pool: h.deps.pool, logger: h.deps.logger, recipient: OPERATOR.email });
    expect(h.stored()).toMatchObject({ sentAt: null, attemptedAt: NOW });
  });

  it('does not touch the record of an address that is no longer the operator', async () => {
    // A late failure report for the old EA must not invalidate the new one's confirmation.
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation({ email: OTHER.email }) });
    await markOperatorConfirmationUndelivered({ pool: h.deps.pool, logger: h.deps.logger, recipient: OTHER.email });
    expect(h.stored()).toMatchObject({ email: OTHER.email, sentAt: NOW });
  });

  it('does not clear a newer confirmation when the failure is for the address it replaced', async () => {
    // A was confirmed, then the operator changed to B and B's confirmation was sent; A's delivery
    // failure arrives late. B worked, so B's record must stand (#2710 review).
    const OTHER_OPERATOR: OperatorSetting = { name: 'Sam', email: 'new@example.com' };
    const h = makeHarness({ operator: OTHER_OPERATOR, confirmation: confirmation({ email: OTHER_OPERATOR.email }) });
    await markOperatorConfirmationUndelivered({ pool: h.deps.pool, logger: h.deps.logger, recipient: OPERATOR.email });
    expect(h.stored()).toMatchObject({ email: OTHER_OPERATOR.email, sentAt: NOW });
  });

  it('matches the address case-insensitively, as the setting is stored lower-cased', async () => {
    const h = makeHarness({ operator: OPERATOR, confirmation: confirmation() });
    await markOperatorConfirmationUndelivered({ pool: h.deps.pool, logger: h.deps.logger, recipient: 'Sam@Example.com' });
    expect(h.stored()).toMatchObject({ sentAt: null });
  });
});

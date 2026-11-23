// operator.ts — the console's Operator setting (#2710, ADR-068).
//
// The operator is the person who set Curia up when that was not the principal: an EA, an IT
// person, a technical friend. Setup records them once; this route is how they are viewed,
// changed or cleared afterwards, because EAs leave. Two rules shape it:
//
//   - **An explicit Save.** The console saves on a button, never on blur, which is why this is
//     a PUT of the whole pair rather than a patch of one field (see docs/dev/review-checklist.md
//     "stale responses" for the read side).
//   - **A confirmation notice.** Saving an email sends one short notice to that address and the
//     response says whether it was published. That is the smoke test for a typo — nothing else
//     would reveal a mistyped address, and copying notices to the principal instead would break
//     the no-duplication rule.
//
// The change history comes from `settings_history` (#2709), written in the same transaction as
// every value.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '../../../logger.js';
import { InvalidSettingError, countSettingHistory, getSettingRecords, readSettingHistory, setSetting, clearSetting } from '../../../settings/store.js';
import type { OperatorSetting } from '../../../settings/registry.js';
import { SETTINGS } from '../../../settings/registry.js';
import {
  confirmationAfterSave,
  readOperatorConfirmationStatus,
  sendPendingOperatorConfirmation,
  type OperatorConfirmationStatus,
} from '../../../notifications/operator-confirmation.js';
import type { OutboundGateway } from '../../../skills/outbound-gateway.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';

/** How many history rows a page holds when the caller does not say. */
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;

export interface OperatorRouteOptions {
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  pool: Pool;
  logger: Logger;
  /** The one system-notice path, for the confirmation (#2710). Absent: the save reports that
   *  the notice could not be sent. */
  outboundGateway?: Pick<OutboundGateway, 'publishNotification'>;
  /** The console's origin, for the notice's link. */
  appOrigin?: string;
  /**
   * Keep the gateway's cached operator address current (#2710). Called after a save or a clear,
   * so a later failing database read cannot route a `database_unavailable` notice to whoever held
   * the setting before.
   */
  onOperatorChanged?: (operator: OperatorSetting | null) => void;
  /** Whether a channel adapter delivers notifications right now (the gateway checks it too; this
   *  lets the response say "pending" instead of a failure when nothing can send yet). */
  canDeliver?: () => boolean;
}

export async function operatorRoutes(
  app: FastifyInstance,
  options: OperatorRouteOptions,
): Promise<void> {
  const { webAppBootstrapSecret, sessions, pool, logger, outboundGateway, appOrigin, onOperatorChanged, canDeliver } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // Writes take the tighter auth rate (10/min): a change here redirects Curia's technical
  // alerts, so it is a target worth throttling. Reads take the console read limit.
  const AUTH_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  /** Send the notice while one is owed, and answer with where it stands. Shared by both writes. */
  async function confirmNow(): Promise<OperatorConfirmationStatus> {
    return sendPendingOperatorConfirmation({
      pool,
      ...(outboundGateway ? { gateway: outboundGateway } : {}),
      ...(canDeliver ? { canDeliver } : {}),
      ...(appOrigin ? { appOrigin } : {}),
      logger,
    });
  }

  // -- GET /api/operator --
  app.get('/api/operator', CONSOLE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      const records = await getSettingRecords(pool, ['operator', 'operator_confirmation'], logger);
      const record = records.operator;
      return reply.send({
        operator: record ? { name: record.value.name, email: record.value.email } : null,
        updatedBy: record?.updatedBy ?? null,
        // Sent, pending (owed, not attempted yet) or failed — and when (ADR-068).
        confirmation: await readOperatorConfirmationStatus(pool, logger),
      });
    } catch (err) {
      request.log.error({ err }, 'GET /api/operator: failed to read the operator setting');
      return reply.status(500).send({ error: 'Failed to read the operator setting. Check server logs.' });
    }
  });

  // -- PUT /api/operator --
  //
  // Sets or clears the operator. `{ name, email }` saves both halves together (the registry's
  // schema is the pair); `{ clear: true }` removes it, which makes the install "Myself" again
  // and sends every notice to the principal. Nothing is saved half-way.
  app.put<{ Body: unknown }>('/api/operator', AUTH_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const parsed = parseOperatorUpdate(request.body);
    if ('error' in parsed) return reply.status(400).send({ error: parsed.error });

    if ('clear' in parsed) {
      try {
        await clearSetting(pool, 'operator', 'console', logger);
        onOperatorChanged?.(null);
        return reply.send({ operator: null, confirmation: { state: 'none' } satisfies OperatorConfirmationStatus });
      } catch (err) {
        request.log.error({ err }, 'PUT /api/operator: failed to clear the operator setting');
        return reply.status(500).send({ error: 'Failed to clear the operator setting. Check server logs.' });
      }
    }

    try {
      const operator: OperatorSetting = parsed.operator;
      // An unchanged save is not a new operator: no write. It still retries a confirmation that
      // is owed (pending or failed) — confirmNow sends nothing once it is sent — so pressing Save
      // cannot email an address on every press, but can retry one that never got its notice.
      const current = (await getSettingRecords(pool, ['operator'], logger)).operator?.value;
      const unchanged = current?.name === operator.name && current.email === operator.email;
      if (!unchanged) await setSetting(pool, 'operator', operator, 'console', logger);
      onOperatorChanged?.(operator);
      // After the write, so the notice goes to the address that is now stored. The setting is
      // saved either way: a notice or status lookup that fails reports `failed`, not a 500.
      const confirmation = await confirmationAfterSave(confirmNow, operator.email, logger);
      return reply.send({ operator, confirmation });
    } catch (err) {
      if (err instanceof InvalidSettingError) {
        return reply.status(400).send({ error: err.message });
      }
      request.log.error({ err }, 'PUT /api/operator: failed to save the operator setting');
      return reply.status(500).send({ error: 'Failed to save the operator setting. Check server logs.' });
    }
  });

  // -- GET /api/operator/history --
  app.get('/api/operator/history', CONSOLE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const query = request.query as Record<string, unknown> | null;
    const limit = clampInt(query?.['limit'], DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
    const offset = clampInt(query?.['offset'], 0, 0, Number.MAX_SAFE_INTEGER);
    try {
      const [history, total] = await Promise.all([
        readSettingHistory(pool, 'operator', { limit, offset }),
        countSettingHistory(pool, 'operator'),
      ]);
      return reply.send({
        // Old and new both go through the registry's parser: a value written before a schema
        // change reads as unreadable, and the console shows that rather than trusting it.
        history: history.map((row) => ({
          id: row.id,
          previous: describeOperatorValue(row.oldValue),
          current: describeOperatorValue(row.newValue),
          changedBy: row.updatedBy,
          changedAt: row.changedAt.toISOString(),
        })),
        total,
      });
    } catch (err) {
      request.log.error({ err }, 'GET /api/operator/history: failed to read the change history');
      return reply.status(500).send({ error: 'Failed to read the change history. Check server logs.' });
    }
  });
}

/** A history value as the console shows it: the pair, cleared, or "unreadable". */
function describeOperatorValue(raw: unknown): { name: string; email: string } | null | 'unreadable' {
  if (raw === null || raw === undefined) return null;
  const parsed = SETTINGS.operator.parse(raw);
  return parsed.ok ? parsed.value : 'unreadable';
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Validate a PUT /api/operator body. Unknown fields are refused, not ignored: a console bug that
 * sends the wrong key should fail loudly rather than half-save a setting that redirects alerts.
 */
export function parseOperatorUpdate(
  body: unknown,
): { operator: OperatorSetting } | { clear: true } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Expected a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  const known = ['name', 'email', 'clear'];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length > 0) return { error: `Unknown field: ${unknown.join(', ')}.` };

  if (input['clear'] !== undefined) {
    if (input['clear'] !== true) return { error: 'clear must be true when given.' };
    if (input['name'] !== undefined || input['email'] !== undefined) {
      return { error: 'Send either clear or the operator details, not both.' };
    }
    return { clear: true };
  }

  const name = input['name'];
  const email = input['email'];
  if (name === undefined || email === undefined) {
    return { error: "Send the operator's name and email together." };
  }
  // The registry's parser is the single validator (shape, length, lower-casing), so the route
  // and a direct settings write cannot disagree about what a valid operator is.
  const parsed = SETTINGS.operator.parse({ name, email });
  if (!parsed.ok) return { error: `Invalid operator: ${parsed.error}.` };
  return { operator: parsed.value };
}

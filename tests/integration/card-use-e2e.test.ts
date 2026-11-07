// End to end on real Postgres: a saved card is usable only after the principal approves a
// checkout (#1358, ADR-060). The real ExecutionLayer, card-use tools, CardUseService,
// ApprovalTriggerService, ActionLogRepo, CardUseRepo and SecretsService run together; only the
// bus is a stub and the fill itself is a probe tool that calls ctx.resolveSecretRef.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import type { ToolHandler, ToolManifest, ToolResult } from '../../src/skills/types.js';
import type { EventBus } from '../../src/bus/bus.js';
import { SecretsService } from '../../src/secrets/secrets-service.js';
import { CardUseRepo } from '../../src/secrets/card-use-repo.js';
import { CardUseService } from '../../src/secrets/card-use-service.js';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { ApprovalTriggerService } from '../../src/autonomy/approval-trigger.js';
import { approveFromConsole } from '../../src/dashboard/console-approval.js';
import { SecretRefRefusal, type CreditCardPublicFields } from '../../src/secrets/structured-secret-schema.js';
import { CardUseConfirmHandler } from '../../skills/web/tools/card-use-confirm/handler.js';
import { CardUseRequestHandler } from '../../skills/web/tools/card-use-request/handler.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIf = DATABASE_URL ? describe : describe.skip;
const logger = pino({ level: 'silent' });

function manifestOf(tool: string): ToolManifest {
  const path = resolve(import.meta.dirname, `../../skills/web/tools/${tool}/tool.json`);
  return JSON.parse(readFileSync(path, 'utf-8')) as ToolManifest;
}

describeIf('saved card checkout, end to end', () => {
  let pool: pg.Pool;
  let secrets: SecretsService;
  let layer: ExecutionLayer;
  let actionLog: ActionLogRepo;
  let cardUse: CardUseService;
  let outcome: { value?: string; refusal?: string };
  let probeRef = { ref: '', siteUrl: '' };

  const suffix = randomBytes(4).toString('hex');
  const cardName = `user.e2e_card_${suffix}`;
  const conversationId = `conv-${suffix}`;
  const requestTaskId = randomUUID();
  const SITE = 'https://shop.example.com/checkout';
  const PUBLIC: CreditCardPublicFields = {
    brand: 'visa', last4: '1111', expiry_month: '12', expiry_year: '2030', cardholder_name: 'Pat Doe',
  };
  const SECRET = { _schema: 'credit_card' as const, number: '4111111111111111', cvv: '123' };

  /** Resolve a card ref the way web-browser does, in the given conversation. */
  async function fill(ref: string, siteUrl: string, inConversation = conversationId) {
    probeRef = { ref, siteUrl };
    outcome = {};
    await layer.invoke('web-browser', {}, undefined, { conversationId: inConversation });
    return outcome;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    secrets = new SecretsService(pool, randomBytes(32), logger);
    await secrets.setCard(cardName, SECRET, PUBLIC, 'E2E');

    const bus = { publish: vi.fn().mockResolvedValue(undefined) } as unknown as EventBus;
    actionLog = new ActionLogRepo(pool, logger);
    const approvalTrigger = new ApprovalTriggerService(actionLog, logger, bus);
    const cardUseRepo = new CardUseRepo(pool);
    cardUse = new CardUseService({ repo: cardUseRepo, secrets, approvalTrigger, bus, logger });

    const probe: ToolHandler = {
      execute: async (ctx): Promise<ToolResult> => {
        try {
          outcome = { value: await ctx.resolveSecretRef!(probeRef.ref, { siteUrl: probeRef.siteUrl }) };
        } catch (err) {
          outcome = { refusal: err instanceof SecretRefRefusal ? err.code : `error: ${String(err)}` };
        }
        return { success: true, data: 'ok' };
      },
    };
    const registry = new ToolRegistry();
    registry.register(manifestOf('card-use-request'), new CardUseRequestHandler());
    registry.register(manifestOf('card-use-confirm'), new CardUseConfirmHandler());
    registry.register({
      name: 'web-browser', description: 'probe', version: '1.0.0', sensitivity: 'normal', action_risk: 'none',
      inputs: {}, outputs: {}, permissions: [], secrets: [], timeout: 5000, capabilities: ['secretResolver'],
    }, probe);
    layer = new ExecutionLayer(registry, logger, {
      bus,
      secretsService: secrets,
      cardUseRepo,
      cardUseService: cardUse,
      actionLogRepo: actionLog,
      approvalTrigger,
    });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM card_use_requests WHERE secret_name = $1', [cardName]);
    await pool.query('DELETE FROM autonomy_action_log WHERE task_id = $1', [requestTaskId]);
    await pool.query('DELETE FROM secrets WHERE name = $1', [cardName]);
    await pool.query('DELETE FROM user_secret_details WHERE name = $1', [cardName]);
    await pool.end();
  });

  it('refuses a fill, files a confirmation, and fills only the approved site and conversation once the principal approves', async () => {
    // No grant yet.
    expect((await fill(`${cardName}#expiry_mm`, SITE)).refusal).toBe('card_use_required');

    // The coordinator files the request. It writes no grant.
    const requested = await layer.invoke(
      'card-use-request',
      { secret_name: cardName, site_url: SITE, amount: 'CA$412.30', purpose: 'flight' },
      undefined,
      { agentId: 'coordinator', conversationId, taskEventId: requestTaskId },
    );
    expect(requested.success).toBe(true);
    const shortRef = (requested as { success: true; data: { approval_ref: string } }).data.approval_ref;
    expect((await fill(`${cardName}#expiry_mm`, SITE)).refusal).toBe('card_use_required');

    // deliver-approval claims the delivery.
    const pending = await actionLog.resolvePending(shortRef);
    if (!pending.found) throw new Error(`approval ${shortRef} not found`);
    expect(pending.row.toolName).toBe('card-use-confirm');
    expect(await actionLog.claimNotification(pending.row.id)).toBe(true);
    const delivered = await actionLog.resolvePending(shortRef);
    if (!delivered.found) throw new Error('delivered approval not found');
    expect(delivered.row.notificationSentAt).not.toBeNull();

    // The principal approves from the console.
    const approved = await approveFromConsole(delivered.row, {
      actionLogRepo: actionLog,
      executionLayer: layer,
      cardUse,
      principalContactId: randomUUID(),
      logger,
    });
    expect(approved).toEqual({ ok: true, sent: true });

    const grants = await pool.query<{ status: string; last4: string }>(
      'SELECT status, last4 FROM card_use_requests WHERE secret_name = $1', [cardName],
    );
    expect(grants.rows).toEqual([{ status: 'approved', last4: '1111' }]);

    // The grant covers this conversation on the approved site's domain only.
    expect((await fill(`${cardName}#expiry_mm`, SITE)).value).toBe('12');
    expect((await fill(`${cardName}#expiry_mm`, 'https://evil.example.org/pay')).refusal).toBe('card_use_required');
    expect((await fill(`${cardName}#expiry_mm`, SITE, `${conversationId}-other`)).refusal).toBe('card_use_required');

    // A card replaced during the window is not covered, even when it ends in the same four digits.
    await secrets.setCard(cardName, SECRET, PUBLIC, 'E2E');
    expect((await fill(`${cardName}#expiry_mm`, SITE)).refusal).toBe('card_use_required');
  });
});

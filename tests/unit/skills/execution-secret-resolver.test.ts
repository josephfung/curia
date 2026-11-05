// Saved-card resolution through ctx.resolveSecretRef (#1358, ADR-027): #field addressing,
// bare-card refusal, the card-use grant check and the secret.accessed audit.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { ExecutionLayer, type InvokeOptions } from '../../../src/skills/execution.js';
import type { ToolHandler, ToolManifest, ToolResult } from '../../../src/skills/types.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { SecretsService } from '../../../src/secrets/secrets-service.js';
import type { CardUseRepo } from '../../../src/secrets/card-use-repo.js';
import {
  BARE_CARD_REF_ERROR,
  CARD_FILL_LIMIT_ERROR,
  CARD_USE_REQUIRED_ERROR,
  SecretRefRefusal,
  type CreditCardPublicFields,
} from '../../../src/secrets/structured-secret-schema.js';

const logger = pino({ level: 'silent' });

const SITE = 'https://shop.example.com/checkout';
const PUBLIC: CreditCardPublicFields = {
  brand: 'visa',
  last4: '1111',
  expiry_month: '12',
  expiry_year: '2030',
  cardholder_name: 'Ada Lovelace',
};
const NUMBER = '4111111111111111';
const CVV = '123';

const manifest: ToolManifest = {
  name: 'web-browser',
  description: 'web-browser description',
  version: '1.0.0',
  sensitivity: 'normal',
  action_risk: 'none',
  inputs: {},
  outputs: {},
  permissions: [],
  secrets: [],
  timeout: 5000,
  capabilities: ['secretResolver'],
};

interface Setup {
  resolve: (ref: string, opts?: { siteUrl?: string }, invoke?: InvokeOptions) => Promise<{ value?: string; error?: string; code?: string; refusal?: boolean }>;
  secrets: Record<'get' | 'getJSON' | 'getStructuredSchema' | 'getCardPublic' | 'getCardSecret', ReturnType<typeof vi.fn>>;
  consumeFill: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
}

function setup(opts: {
  schema?: 'credit_card' | null;
  grant?: 'ok' | 'no_grant' | 'fill_limit';
  publicFields?: CreditCardPublicFields;
  wireRepo?: boolean;
  plain?: string | null;
} = {}): Setup {
  const secrets = {
    get: vi.fn().mockResolvedValue(opts.plain === undefined ? 'plain-value' : opts.plain),
    getJSON: vi.fn(),
    getStructuredSchema: vi.fn().mockResolvedValue(opts.schema ?? null),
    getCardPublic: vi.fn().mockResolvedValue({ label: null, publicFields: opts.publicFields ?? PUBLIC }),
    getCardSecret: vi.fn().mockResolvedValue({ _schema: 'credit_card', number: NUMBER, cvv: CVV }),
  };
  const consumeFill = vi.fn().mockResolvedValue(opts.grant ?? 'ok');
  const publish = vi.fn().mockResolvedValue(undefined);
  const registry = new ToolRegistry();
  let current: { ref: string; opts?: { siteUrl?: string } } = { ref: '' };
  let outcome: { value?: string; error?: string; code?: string; refusal?: boolean } = {};
  const handler: ToolHandler = {
    execute: vi.fn(async (ctx): Promise<ToolResult> => {
      try { outcome = { value: await ctx.resolveSecretRef!(current.ref, current.opts) }; }
      catch (e) { outcome = { error: (e as Error).message, refusal: e instanceof SecretRefRefusal, code: e instanceof SecretRefRefusal ? e.code : undefined }; }
      return { success: true, data: 'ok' };
    }),
  };
  registry.register(manifest, handler);
  const layer = new ExecutionLayer(registry, logger, {
    bus: { publish } as unknown as EventBus,
    secretsService: secrets as unknown as SecretsService,
    ...(opts.wireRepo === false ? {} : { cardUseRepo: { consumeFill } as unknown as CardUseRepo }),
  });
  return {
    secrets,
    consumeFill,
    publish,
    resolve: async (ref, o, invoke) => {
      current = { ref, opts: o };
      outcome = {};
      await layer.invoke('web-browser', {}, undefined, { conversationId: 'conv-1', ...invoke });
      return outcome;
    },
  };
}

describe('resolveSecretRef: saved cards', () => {
  it('bare ref to a card is refused with field list', async () => {
    const s = setup({ schema: 'credit_card' });
    const r = await s.resolve('user.visa', { siteUrl: SITE });
    expect(r.error).toBe(BARE_CARD_REF_ERROR('user.visa'));
    expect(r.code).toBe('bare_card_ref');
    expect(r.refusal).toBe(true);
    expect(r.error).toContain('user.visa#number');
    expect(r.error).toContain('expiry_mm_yy');
    expect(s.secrets.get).not.toHaveBeenCalled();
    expect(s.secrets.getCardSecret).not.toHaveBeenCalled();
  });

  it('untagged json secret: bare ref unchanged, # refused', async () => {
    const s = setup({ schema: null, plain: '{"a":1}' });
    expect((await s.resolve('user.blob')).value).toBe('{"a":1}');
    const r = await s.resolve('user.blob#a', { siteUrl: SITE });
    expect(r.error).toMatch(/works only on saved cards/);
    expect(r.code).toBe('not_a_card');
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('string secret: bare ref unchanged (returns get() value), # refused', async () => {
    const s = setup({ schema: null, plain: 'hunter2' });
    expect((await s.resolve('user.site_pw')).value).toBe('hunter2');
    expect(s.secrets.get).toHaveBeenCalledWith('user.site_pw');
    expect((await s.resolve('user.site_pw#number', { siteUrl: SITE })).error).toMatch(/works only on saved cards/);
  });

  it('channel.x#number refused by namespace guard', async () => {
    const s = setup({ schema: 'credit_card' });
    expect((await s.resolve('channel.x#number', { siteUrl: SITE })).error).toMatch(/user\./);
    expect((await s.resolve('#cvv', { siteUrl: SITE })).error).toMatch(/user\./);
    expect(s.secrets.getStructuredSchema).not.toHaveBeenCalled();
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('public field resolves with grant and makes no decrypt call', async () => {
    const s = setup({ schema: 'credit_card' });
    const r = await s.resolve('user.visa#expiry_month_name', { siteUrl: SITE });
    expect(r.value).toBe('December');
    expect(s.consumeFill).toHaveBeenCalledWith({
      secretName: 'user.visa', last4: '1111', siteUrl: SITE, conversationId: 'conv-1', field: null,
    });
    expect(s.secrets.get).not.toHaveBeenCalled();
    expect(s.secrets.getJSON).not.toHaveBeenCalled();
    expect(s.secrets.getCardSecret).not.toHaveBeenCalled();
  });

  it('secret field resolves with grant', async () => {
    const s = setup({ schema: 'credit_card' });
    expect((await s.resolve('user.visa#number', { siteUrl: SITE })).value).toBe(NUMBER);
    expect((await s.resolve('user.visa#cvv', { siteUrl: SITE })).value).toBe(CVV);
    expect(s.consumeFill).toHaveBeenNthCalledWith(1, expect.objectContaining({ field: 'number' }));
    expect(s.consumeFill).toHaveBeenNthCalledWith(2, expect.objectContaining({ field: 'cvv' }));
  });

  it('no grant -> CARD_USE_REQUIRED_ERROR, even when humanApproved or principal-originated', async () => {
    const s = setup({ schema: 'credit_card', grant: 'no_grant' });
    const expected = CARD_USE_REQUIRED_ERROR('user.visa', 'example.com');
    expect((await s.resolve('user.visa#number', { siteUrl: SITE })).error).toBe(expected);
    expect((await s.resolve('user.visa#number', { siteUrl: SITE }, { humanApproved: true })).error).toBe(expected);
    const principal = await s.resolve('user.visa#number', { siteUrl: SITE }, {
      taskMetadata: { originator: { contactId: 'principal-1', channel: 'signal' } },
      liveTurn: true,
    });
    expect(principal.error).toBe(expected);
    expect(principal.code).toBe('card_use_required');
    expect(s.secrets.getCardSecret).not.toHaveBeenCalled();
  });

  it('fill_limit -> CARD_FILL_LIMIT_ERROR', async () => {
    const s = setup({ schema: 'credit_card', grant: 'fill_limit' });
    const r = await s.resolve('user.visa#cvv', { siteUrl: SITE });
    expect(r.error).toBe(CARD_FILL_LIMIT_ERROR);
    expect(r.code).toBe('card_fill_limit');
    expect(s.secrets.getCardSecret).not.toHaveBeenCalled();
  });

  it('no siteUrl -> refused before any grant is consumed', async () => {
    const s = setup({ schema: 'credit_card' });
    expect((await s.resolve('user.visa#number')).code).toBe('no_site');
    expect((await s.resolve('user.visa#number')).error).toMatch(/web page/);
    expect((await s.resolve('user.visa#number', { siteUrl: '' })).error).toMatch(/web page/);
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('fails closed without a CardUseRepo or without a conversation', async () => {
    const noRepo = setup({ schema: 'credit_card', wireRepo: false });
    expect((await noRepo.resolve('user.visa#number', { siteUrl: SITE })).error).toMatch(/needs the principal's confirmation/);
    expect(noRepo.secrets.getCardSecret).not.toHaveBeenCalled();

    // A missing conversationId is no_grant (the repo is not even asked).
    const s = setup({ schema: 'credit_card' });
    const r = await s.resolve('user.visa#expiry_mm', { siteUrl: SITE }, { conversationId: undefined });
    expect(r.error).toMatch(/needs the principal's confirmation/);
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('untagged card JSON in the vault: bare ref refused, error carries no value', async () => {
    const s = setup({ schema: null, plain: JSON.stringify({ _schema: 'credit_card', number: NUMBER, cvv: CVV }) });
    const r = await s.resolve('user.orphan');
    expect(r.error).toBe(BARE_CARD_REF_ERROR('user.orphan'));
    expect(r.code).toBe('bare_card_ref');
    expect(r.value).toBeUndefined();
    expect(r.error).not.toContain('4111');
  });

  it('unknown field fails before the grant is consumed', async () => {
    const s = setup({ schema: 'credit_card' });
    const r = await s.resolve('user.visa#pin', { siteUrl: SITE });
    expect(r.error).toMatch(/Unknown card field/);
    expect(r.code).toBe('unknown_card_field');
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('missing public fields fail before the grant is consumed', async () => {
    const s = setup({ schema: 'credit_card' });
    s.secrets.getCardPublic.mockResolvedValue(null);
    expect((await s.resolve('user.visa#number', { siteUrl: SITE })).error).toMatch(/not found/);
    expect(s.consumeFill).not.toHaveBeenCalled();
  });

  it('refuses an empty projection (no billing_zip saved)', async () => {
    const s = setup({ schema: 'credit_card' });
    const r = await s.resolve('user.visa#billing_zip', { siteUrl: SITE });
    expect(r.error).toBe('`user.visa` has no billing_zip saved');
    expect(r.code).toBe('empty_field');
    expect(r.value).toBeUndefined();
  });

  it('rejects an unknown card field', async () => {
    const s = setup({ schema: 'credit_card' });
    expect((await s.resolve('user.visa#pin', { siteUrl: SITE })).error).toMatch(/Unknown card field/);
  });

  it('emits exactly one secret.accessed with secretField and no value', async () => {
    const s = setup({ schema: 'credit_card' });
    await s.resolve('user.visa#number', { siteUrl: SITE }, { agentId: 'agent-1', taskEventId: 'task-1' });
    const accessed = s.publish.mock.calls.filter(([, e]) => (e as { type: string }).type === 'secret.accessed');
    expect(accessed).toHaveLength(1);
    const payload = (accessed[0]![1] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({
      toolName: 'web-browser', secretName: 'user.visa', secretField: 'number', byReference: true, source: 'vault',
    });
    const serialized = JSON.stringify(accessed.map(([, e]) => (e as { payload: unknown }).payload));
    expect(serialized).not.toContain('4111');
    expect(serialized).not.toContain(CVV);
  });

  it('emits no secret.accessed when the grant is refused', async () => {
    const s = setup({ schema: 'credit_card', grant: 'no_grant' });
    await s.resolve('user.visa#number', { siteUrl: SITE });
    expect(s.publish.mock.calls.filter(([, e]) => (e as { type: string }).type === 'secret.accessed')).toHaveLength(0);
  });
});

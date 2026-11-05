// handler.test.ts — secret-capture-request skill.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureRequestHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { SecretCaptureMinter, MintResult } from '../../src/secrets/secret-capture-service.js';

function fakeMinter(over: Partial<MintResult> = {}): SecretCaptureMinter & { userCalls: unknown[]; systemCalls: unknown[]; detailCalls: unknown[]; cardCalls: unknown[] } {
  const userCalls: unknown[] = [];
  const systemCalls: unknown[] = [];
  const detailCalls: unknown[] = [];
  const cardCalls: unknown[] = [];
  return {
    cardCalls,
    userCalls,
    systemCalls,
    detailCalls,
    async mintUserSecret(args) {
      userCalls.push(args);
      return { rawToken: 'abc123', secretName: 'user.flight', expiresAt: new Date(Date.now() + 30 * 60_000), reusedExisting: false, ...over };
    },
    async mintSystemSecret(args) {
      systemCalls.push(args);
      return { rawToken: 'abc123', secretName: 'anthropic_api_key', expiresAt: new Date(), ...over };
    },
    async setUserSecretDetails(rawName, details) {
      detailCalls.push({ rawName, details });
      return { secretName: 'user.flight' };
    },
    async setUserCardPublic(rawName, edit) {
      cardCalls.push({ rawName, edit });
      if (rawName === 'user.refused') throw new Error('This card has expired.');
      return { secretName: 'user.personal_visa_card' };
    },
  };
}

function makeCtx(input: Record<string, unknown>, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input,
    secret: () => 'unused',
    log: pino({ level: 'silent' }),
    secretCapture: fakeMinter(),
    appOrigin: 'https://curia.example.com',
    ...overrides,
  } as unknown as ToolContext;
}

describe('SecretCaptureRequestHandler', () => {
  it('mints a user secret and builds the URL from appOrigin', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'my flight password' }, { secretCapture: minter, timezone: 'America/Toronto' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('https://curia.example.com/secret-capture/abc123');
    expect(data.secret_name).toBe('user.flight');
    expect(data.reused_existing).toBe(false);
    // origin is always present (#972); with no routing on ctx its fields are undefined and
    // resumeIntent falls back to the label. toEqual ignores undefined-valued properties.
    expect(minter.userCalls).toEqual([{ rawName: 'my flight password', label: 'my flight password', valueFormat: 'string', origin: { resumeIntent: 'my flight password' } }]);
    // Timestamp-metadata contract: the field is `displayTimezone` (camelCase), not snake_case.
    expect(typeof data.displayTimezone).toBe('string');
    expect(data).not.toHaveProperty('display_timezone');
  });

  it('falls back to localhost:{httpPort} when appOrigin is unset', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { appOrigin: undefined, httpPort: 4521 });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('http://localhost:4521/secret-capture/abc123');
  });

  it('trims a trailing slash on appOrigin so the URL has no double slash', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { appOrigin: 'https://curia.example.com/' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.capture_url).toBe('https://curia.example.com/secret-capture/abc123');
  });

  it('surfaces reused_existing when the minter bound an existing key', async () => {
    const minter = fakeMinter({ secretName: 'user.x_com_password', reusedExisting: true });
    const ctx = makeCtx({ secret_name: 'twitter password' }, { secretCapture: minter });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.secret_name).toBe('user.x_com_password');
    expect(data.reused_existing).toBe(true);
    expect(String(data.summary)).toMatch(/existing vault key/);
  });

  it('never returns the submitted value (mint surface has no read path)', async () => {
    const ctx = makeCtx({ secret_name: 'x' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    // The output carries only the link + metadata, never a value field.
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(Object.keys(data)).not.toContain('value');
  });

  it('rejects a missing secret_name', async () => {
    const ctx = makeCtx({});
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid value_format', async () => {
    const ctx = makeCtx({ secret_name: 'x', value_format: 'xml' });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('errors when the secretCapture capability is missing', async () => {
    const ctx = makeCtx({ secret_name: 'x' }, { secretCapture: undefined });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
  });

  it('passes value_format through to the minter', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'creds', value_format: 'json' }, { secretCapture: minter });
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls).toEqual([{ rawName: 'creds', label: 'creds', valueFormat: 'json', origin: { resumeIntent: 'creds' } }]);
  });

  it('captures origin routing context from ctx for resume (#972)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      {
        secretCapture: minter,
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        taskMetadata: { originator },
      },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls).toEqual([{
      rawName: 'Aeroplan password',
      label: 'Aeroplan password',
      valueFormat: 'string',
      origin: {
        conversationId: 'conv-1',
        channelId: 'email',
        agentId: 'coordinator',
        taskEventId: 'task-evt-9',
        originator,
        resumeIntent: 'check the Aeroplan balance',
      },
    }]);
  });

  it('retargets origin at the coordinator and mints a resume_token when delegated (#995)', async () => {
    const minter = fakeMinter();
    const originator = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password', resume_intent: 'check the Aeroplan balance' },
      {
        secretCapture: minter,
        // Specialist's own (internal) routing — must NOT be used as the resume target:
        conversationId: 'delegate-xyz',
        channelId: 'internal',
        agentId: 'accounts-specialist',
        taskMetadata: {
          originator,
          delegationOrigin: { conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator', originalTask: 'log into Aeroplan and check balance' },
        },
      },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls[0]).toBeDefined();
    const call = minter.userCalls[0]! as { origin: Record<string, unknown> };
    // Re-entry targets the coordinator on its deliverable channel, not the internal specialist ctx.
    expect(call.origin.conversationId).toBe('user-conv');
    expect(call.origin.channelId).toBe('email');
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin.originator).toEqual(originator);
    // The resume_token names the specialist to re-delegate to.
    const { decodeResumeToken } = await import('../../src/agents/resume-token.js');
    const decoded = decodeResumeToken(call.origin.resumeToken as string)!;
    expect(decoded.agent).toBe('accounts-specialist');
    expect(decoded.original_task).toBe('log into Aeroplan and check balance');
    expect(call.origin.resumeIntent).toBe('check the Aeroplan balance');
  });

  it('does NOT set resumeToken or retarget when not delegated (coordinator-minted)', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx(
      { secret_name: 'Aeroplan password' },
      { secretCapture: minter, conversationId: 'user-conv', channelId: 'email', agentId: 'coordinator' },
    );
    await new SecretCaptureRequestHandler().execute(ctx);
    expect(minter.userCalls[0]).toBeDefined();
    const call = minter.userCalls[0]! as { origin: Record<string, unknown> };
    expect(call.origin.agentId).toBe('coordinator');
    expect(call.origin).not.toHaveProperty('resumeToken');
  });
});

describe('SecretCaptureRequestHandler sign-in details (#2201)', () => {
  it('passes validated login_url and username to the minter', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx(
      { secret_name: 'insurer password', login_url: ' https://id.example.com/ ', username: 'someone' },
      { secretCapture: minter },
    );
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(true);
    expect((minter.userCalls[0] as { details: unknown }).details).toEqual({
      loginUrl: 'https://id.example.com/',
      username: 'someone',
    });
  });

  it('rejects a login_url that is not an http(s) URL', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'x', login_url: 'javascript:alert(1)' }, { secretCapture: minter });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect(minter.userCalls).toHaveLength(0);
  });

  it('details_only saves details without minting a link', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx(
      { secret_name: 'user.flight', login_url: 'https://example.com/login', details_only: true },
      { secretCapture: minter },
    );
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.details_saved).toBe(true);
    expect(data).not.toHaveProperty('capture_url');
    expect(minter.userCalls).toHaveLength(0);
    expect(minter.detailCalls).toEqual([{ rawName: 'user.flight', details: { loginUrl: 'https://example.com/login' } }]);
  });

  it('details_only with no details is an error', async () => {
    const minter = fakeMinter();
    const ctx = makeCtx({ secret_name: 'user.flight', details_only: true }, { secretCapture: minter });
    const result = await new SecretCaptureRequestHandler().execute(ctx);
    expect(result.success).toBe(false);
    expect(minter.detailCalls).toHaveLength(0);
  });
});

describe('SecretCaptureRequestHandler card templates (#1358)', () => {
  const run = (input: Record<string, unknown>, minter = fakeMinter()) =>
    new SecretCaptureRequestHandler().execute(makeCtx(input, { secretCapture: minter }));

  it('credit_card forces json and derives the label from secret_name', async () => {
    const minter = fakeMinter();
    const result = await run({ secret_name: 'personal visa card', template: 'credit_card', value_format: 'string' }, minter);
    expect(result.success).toBe(true);
    expect(minter.userCalls[0]).toMatchObject({ rawName: 'personal visa card', template: 'credit_card', valueFormat: 'json', label: 'Personal', labelDerived: true });
  });

  it('credit_card uses card_label when given, and sends no label when nothing is left to derive', async () => {
    const minter = fakeMinter();
    await run({ secret_name: 'personal visa card', template: 'credit_card', card_label: ' Travel ' }, minter);
    expect(minter.userCalls[0]).toMatchObject({ label: 'Travel' });

    await run({ secret_name: 'visa card', template: 'credit_card' }, minter);
    expect(minter.userCalls[1]).not.toHaveProperty('label');
  });

  it('credit_card_renewal passes the template without a label of its own', async () => {
    const minter = fakeMinter();
    const result = await run({ secret_name: 'user.personal_visa_card', template: 'credit_card_renewal' }, minter);
    expect(result.success).toBe(true);
    const call = minter.userCalls[0] as Record<string, unknown>;
    expect(call).toMatchObject({ rawName: 'user.personal_visa_card', template: 'credit_card_renewal', valueFormat: 'json' });
    expect(call).not.toHaveProperty('label');
  });

  it('surfaces a mint failure such as a renewal of a card that is not saved', async () => {
    const minter = fakeMinter();
    minter.mintUserSecret = async () => { throw new Error("No saved card named 'x'."); };
    const result = await run({ secret_name: 'x', template: 'credit_card_renewal' }, minter);
    expect(result).toEqual({ success: false, error: "No saved card named 'x'." });
  });

  it('rejects an unknown template and card fields that a link cannot take', async () => {
    const minter = fakeMinter();
    expect((await run({ secret_name: 'x', template: 'passport' }, minter)).success).toBe(false);
    expect((await run({ secret_name: 'x', template: 'credit_card', expiry_month: '3' }, minter)).success).toBe(false);
    expect((await run({ secret_name: 'x', card_label: 'Work' }, minter)).success).toBe(false);
    expect(minter.userCalls).toHaveLength(0);
  });

  it('details_only with card fields edits the card and mints no link', async () => {
    const minter = fakeMinter();
    const result = await run({
      secret_name: 'user.personal_visa_card', details_only: true,
      card_label: 'Work', expiry_month: '6', expiry_year: '2031', cardholder_name: 'A B',
    }, minter);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ secret_name: 'user.personal_visa_card', details_saved: true });
    expect(data).not.toHaveProperty('capture_url');
    expect(minter.userCalls).toHaveLength(0);
    expect(minter.detailCalls).toHaveLength(0);
    expect(minter.cardCalls).toEqual([{
      rawName: 'user.personal_visa_card',
      edit: { label: 'Work', expiry_month: '6', expiry_year: '2031', cardholder_name: 'A B' },
    }]);
  });

  it('details_only returns the validation error from the card edit', async () => {
    const result = await run({ secret_name: 'user.refused', details_only: true, expiry_month: '1', expiry_year: '2001' });
    expect(result).toEqual({ success: false, error: 'This card has expired.' });
  });

  it('details_only refuses card fields mixed with sign-in details', async () => {
    const minter = fakeMinter();
    const result = await run({ secret_name: 'user.x', details_only: true, card_label: 'Work', username: 'someone' }, minter);
    expect(result.success).toBe(false);
    expect(minter.cardCalls).toHaveLength(0);
    expect(minter.detailCalls).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { ContactResolver } from '../../contacts/contact-resolver.js';
import type { ContactService } from '../../contacts/contact-service.js';
import type { ChannelPolicyConfig, SenderContext } from '../../contacts/types.js';
import {
  buildPrincipalSenderContext,
  resolveConsoleVoiceCaller,
  resolveVoiceCallerFromToken,
  VOICE_CONSOLE_SENDER_ID,
} from './caller-context.js';

const logger = pino({ level: 'silent' });

const PRINCIPAL_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function partnerSender(): SenderContext {
  return {
    resolved: true,
    contactId: PARTNER_ID,
    displayName: 'Alex Partner',
    role: 'partner',
    systemRole: null,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.9,
    tier: 'trusted',
    kind: 'person',
  };
}

describe('buildPrincipalSenderContext', () => {
  it('forces systemRole/tier/kind to principal even if the row is stale', () => {
    const ctx = buildPrincipalSenderContext({
      id: PRINCIPAL_ID,
      displayName: 'Joseph',
      role: 'ceo',
      systemRole: null,
      kgNodeId: 'kg-1',
      tier: 'known',
    });
    expect(ctx.systemRole).toBe('principal');
    expect(ctx.tier).toBe('principal');
    expect(ctx.kind).toBe('principal');
    expect(ctx.contactId).toBe(PRINCIPAL_ID);
  });

  it('falls back to the synthetic primary-user principal when no row exists', () => {
    const ctx = buildPrincipalSenderContext(null);
    expect(ctx.contactId).toBe('primary-user');
    expect(ctx.systemRole).toBe('principal');
    expect(ctx.tier).toBe('principal');
  });
});

describe('resolveConsoleVoiceCaller', () => {
  it('resolves the principal and stamps liveTurn=true via stampOriginator', async () => {
    const contactService = {
      findContactBySystemRole: vi.fn().mockResolvedValue({
        id: PRINCIPAL_ID,
        displayName: 'Joseph',
        role: 'ceo',
        systemRole: 'principal',
        kgNodeId: null,
        tier: 'principal',
      }),
    } as unknown as ContactService;

    const caller = await resolveConsoleVoiceCaller({ contactService, logger });
    expect(caller.liveTurn).toBe(true);
    expect(caller.contactId).toBe(PRINCIPAL_ID);
    expect(caller.senderId).toBe(VOICE_CONSOLE_SENDER_ID);
    expect(caller.originator.systemRole).toBe('principal');
    expect(caller.originator.channel).toBe('voice');
    expect(caller.originator.tier).toBe('principal');
  });
});

describe('resolveVoiceCallerFromToken', () => {
  it('yields the contact tier/trust and liveTurn=false for a non-principal token', async () => {
    const contactResolver = {
      resolve: vi.fn().mockResolvedValue(partnerSender()),
    } as unknown as ContactResolver;

    const result = await resolveVoiceCallerFromToken({
      contactResolver,
      callerToken: '+15551234567',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.caller.liveTurn).toBe(false);
    expect(result.caller.contactId).toBe(PARTNER_ID);
    expect(result.caller.tier).toBe('trusted');
    expect(result.caller.originator.systemRole).toBeNull();
    expect(result.caller.originator.tier).toBe('trusted');
    expect(contactResolver.resolve).toHaveBeenCalledWith('voice', '+15551234567');
  });

  it('fail-closes an unresolved token under voice unknown_sender: ignore', async () => {
    const contactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'voice',
        senderId: 'unknown-token',
      }),
    } as unknown as ContactResolver;
    const channelPolicies: Record<string, ChannelPolicyConfig> = {
      voice: { trust: 'high', unknownSender: 'ignore', threaded: false },
    };

    const result = await resolveVoiceCallerFromToken({
      contactResolver,
      callerToken: 'unknown-token',
      channelPolicies,
    });

    expect(result).toEqual({ ok: false, reason: 'unknown_sender' });
  });

  it('defaults to ignore (fail-closed) when no voice policy is configured', async () => {
    const contactResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'voice',
        senderId: 'unknown-token',
      }),
    } as unknown as ContactResolver;

    const result = await resolveVoiceCallerFromToken({
      contactResolver,
      callerToken: 'unknown-token',
    });

    expect(result).toEqual({ ok: false, reason: 'unknown_sender' });
  });

  it('does not short-circuit voice to principal — resolve goes to ContactResolver', async () => {
    const contactResolver = {
      resolve: vi.fn().mockResolvedValue(partnerSender()),
    } as unknown as ContactResolver;

    await resolveVoiceCallerFromToken({
      contactResolver,
      callerToken: 'anything',
    });

    expect(contactResolver.resolve).toHaveBeenCalledWith('voice', 'anything');
  });
});

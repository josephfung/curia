// contact-identity-binding.test.ts — #1514
//
// Covers the durable principal-detection fix: bind a Slack identity onto the
// principal contact → structural match → inbound resolves to principal (not a
// lookalike) → Stage-2 judge skips when that identity is the sole recipient.

import { describe, it, expect, vi } from 'vitest';
import { ContactService } from './contact-service.js';
import { isPrincipalIdentity, computePrincipalIsSoleRecipient } from './principal-recipient.js';
import type { ChannelIdentity } from './types.js';
import { OutboundLlmJudge } from '../dispatch/outbound-judge.js';
import type { JudgeConfig } from '../dispatch/outbound-judge.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import { ModelRegistry } from '../agents/llm/model-registry.js';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';

const silentLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

async function makePrincipal(svc: ContactService) {
  const created = await svc.createContact({
    displayName: 'CEO',
    tier: 'known',
    kind: 'person',
    source: 'test',
  });
  // createContact always stores systemRole=null; promote to structural principal.
  return svc.saveContact({
    ...created,
    systemRole: 'principal',
    tier: 'principal',
    kind: 'principal',
  });
}

describe('principal channel-identity binding (#1514)', () => {
  it('binding Slack to the principal makes isPrincipalIdentity match and inbound resolve', async () => {
    const changed: string[] = [];
    const svc = ContactService.createInMemory(undefined, {
      onIdentitiesChanged: (contactId) => { changed.push(contactId); },
    });

    const principal = await makePrincipal(svc);

    // Before binding — Slack DM from the CEO creates a lookalike via ensureChannelContact.
    const lookalike = await svc.ensureChannelContact({
      channel: 'slack',
      channelIdentifier: 'U_CEO',
      displayName: 'CEO',
      source: 'slack_participant',
    });
    expect(lookalike.contactId).not.toBe(principal.id);
    expect(lookalike.created).toBe(true);

    // Merge lookalike → principal (console / agent path for the incident repair).
    await svc.mergeContacts(principal.id, lookalike.contactId, false);
    expect(changed).toContain(principal.id);

    const identities = await svc.getIdentitiesForContact(principal.id);
    const slack = identities.find((i) => i.channel === 'slack');
    expect(slack).toBeDefined();
    expect(slack!.verified).toBe(true);
    expect(slack!.status).toBe('active');

    // Structural principal match (outbound filter / Gate C input).
    expect(isPrincipalIdentity('slack', 'U_CEO', identities)).toBe(true);
    expect(
      computePrincipalIsSoleRecipient([
        { identifier: 'U_CEO', isPrincipal: true },
      ]),
    ).toBe(true);

    // Inbound from the same Slack user now resolves to the principal — no new lookalike.
    const resolved = await svc.resolveByChannelIdentity('slack', 'U_CEO');
    expect(resolved?.contactId).toBe(principal.id);
    expect(resolved?.systemRole).toBe('principal');

    const again = await svc.ensureChannelContact({
      channel: 'slack',
      channelIdentifier: 'U_CEO',
      displayName: 'CEO',
      source: 'slack_participant',
    });
    expect(again.contactId).toBe(principal.id);
    expect(again.created).toBe(false);
  });

  it('linking Slack directly onto the principal verifies and notifies', async () => {
    const changed: string[] = [];
    const svc = ContactService.createInMemory(undefined, {
      onIdentitiesChanged: (contactId) => { changed.push(contactId); },
    });

    const principal = await makePrincipal(svc);

    const identity = await svc.linkIdentity({
      contactId: principal.id,
      channel: 'slack',
      channelIdentifier: 'U0123ABCDEF',
      source: 'ceo_stated',
      verified: true,
    });
    expect(identity.verified).toBe(true);
    expect(changed).toContain(principal.id);

    // Hot-reload pattern used by index.ts — mutate a shared cache in place.
    const cache: ChannelIdentity[] = [];
    const fresh = (await svc.getIdentitiesForContact(principal.id))
      .filter((id) => id.verified && id.status === 'active');
    cache.length = 0;
    cache.push(...fresh);

    expect(isPrincipalIdentity('slack', 'U0123ABCDEF', cache)).toBe(true);
  });

  it('Stage-2 judge skips when principalIsSoleRecipient is true after binding', async () => {
    const provider = {
      id: 'fake',
      chat: vi.fn(async () => {
        throw new Error('LLM should not be called for principal-only sends');
      }),
    } as unknown as LLMProvider;
    const bus = { publish: vi.fn() } as unknown as EventBus;
    const registry = new ModelRegistry(silentLogger);
    const config: JudgeConfig = {
      enabled: true,
      model: 'claude-haiku-4-5',
      timeoutMs: 5000,
      failMode: 'split',
    };
    const judge = new OutboundLlmJudge(provider, config, bus, silentLogger, registry);

    const findings = await judge.review({
      content: 'Hi — your Google Docs auth failed; retry the OAuth grant.',
      recipients: [{ email: 'U_CEO', isPrincipal: true }],
      principalIncluded: true,
      principalIsSoleRecipient: true,
      conversationId: 'conv-1',
      channelId: 'slack',
    });
    expect(findings).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });
});

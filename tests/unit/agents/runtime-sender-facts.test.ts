// The sender context states contact-identity verification and per-message authentication
// as two separate facts (#2312). A report once called a verified contact an "unverified
// sender" because a failed SPF/DKIM/DMARC check and the contact's identity shared a word.

import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';

const PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' } as const;

const IDENTITY_VERIFIED = 'Contact identity: verified (whether this address is confirmed as belonging to this contact)';
const IDENTITY_NOT_VERIFIED = 'Contact identity: not verified (whether this address is confirmed as belonging to this contact)';

async function senderBlock(opts: {
  channelId: string;
  resolved: boolean;
  identityVerified?: boolean;
  metadata?: Record<string, unknown>;
  principal?: boolean;
}): Promise<string> {
  const bus = new EventBus(createLogger('error'));
  const provider: LLMProvider & { chat: ReturnType<typeof vi.fn> } = {
    id: 'mock',
    chat: vi.fn(async () => ({
      type: 'text' as const,
      content: 'Done.',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: PROVENANCE,
    })),
  };
  new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are helpful.',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger: createLogger('error'),
  }).register();

  await bus.publish('dispatch', createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-sender-facts',
    channelId: opts.channelId,
    senderId: 'sam@example.com',
    content: 'Hello',
    parentEventId: 'parent-sender-facts',
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    senderContext: opts.resolved
      ? {
          resolved: true,
          contactId: 'contact-1',
          displayName: 'Sam Lee',
          role: null,
          systemRole: opts.principal ? 'principal' as const : null,
          tier: opts.principal ? 'principal' as const : 'known' as const,
          kind: 'person' as const,
          verified: opts.identityVerified ?? false,
          kgNodeId: null,
          knowledgeSummary: '',
          authorization: {
            allowed: ['view_basic_info'],
            denied: [] as string[],
            escalate: [] as string[],
            channelTrust: 'low' as const,
            trustBlocked: [] as string[],
          },
          contactConfidence: 0.5,
        }
      : { resolved: false as const, channel: opts.channelId, senderId: 'sam@example.com' },
  }));

  const messages = provider.chat.mock.calls[0]![0].messages as Array<{ role: string; content: string }>;
  return messages.filter(m => m.role === 'system').map(m => m.content).join('\n---\n');
}

describe('sender context: identity and authentication are separate facts', () => {
  it('renders a verified contact whose message failed authentication as both facts', async () => {
    const block = await senderBlock({
      channelId: 'email', resolved: true, identityVerified: true, metadata: { senderVerified: false },
    });
    expect(block).toContain(IDENTITY_VERIFIED);
    expect(block).toContain('Message authentication: failed (SPF/DKIM/DMARC for this message)');
    expect(block).not.toContain('senderVerified');
    expect(block).not.toContain('[unverified]');
  });

  it('renders an unverified contact whose message passed authentication', async () => {
    const block = await senderBlock({
      channelId: 'email', resolved: true, identityVerified: false, metadata: { senderVerified: true },
    });
    expect(block).toContain(IDENTITY_NOT_VERIFIED);
    expect(block).toContain('Message authentication: passed (SPF/DKIM/DMARC for this message)');
  });

  it('renders an email with no authentication result as not confirmed, not failed (#2312)', async () => {
    const block = await senderBlock({
      channelId: 'email', resolved: true, identityVerified: true, metadata: { senderVerified: false, senderAuthentication: 'not confirmed' },
    });
    expect(block).toContain('Message authentication: not confirmed (SPF/DKIM/DMARC for this message)');
    expect(block).not.toContain('Message authentication: failed');
  });

  it('renders authentication as not available on a non-email channel', async () => {
    const block = await senderBlock({ channelId: 'signal', resolved: true, identityVerified: true });
    expect(block).toContain(IDENTITY_VERIFIED);
    expect(block).toContain('Message authentication: not available (SPF/DKIM/DMARC for this message)');
  });

  it('renders an unresolved sender as not verified, with its authentication result', async () => {
    const block = await senderBlock({
      channelId: 'email', resolved: false, metadata: { senderVerified: true },
    });
    expect(block).toContain(IDENTITY_NOT_VERIFIED);
    expect(block).toContain('Message authentication: passed (SPF/DKIM/DMARC for this message)');
    expect(block).not.toContain('senderVerified');
  });
});

// GHSA-p49r-jqh2-v668: a message that matches the principal's number or address without the channel
// proving it keeps the principal's identity but not their authority. The coordinator is told, so it
// says a confirmation is waiting instead of asking the principal to repeat themselves.
describe('sender context: an unauthenticated principal match', () => {
  const LINE = 'This message matches the principal\'s address, but its channel did not prove they sent it.';
  const principalOriginator = (channel: string, authenticated: boolean) => ({
    originator: { contactId: 'contact-1', systemRole: 'principal', channel, initiatedAt: '2026-11-17T12:00:00Z', tier: 'principal', authenticated },
  });

  it.each([
    ['sms', principalOriginator('sms', false)],
    ['email', { ...principalOriginator('email', false), senderVerified: false }],
  ])('says so on %s', async (channelId, metadata) => {
    const block = await senderBlock({ channelId, resolved: true, identityVerified: true, principal: true, metadata });
    expect(block).toContain(LINE);
    expect(block).toContain('don\'t ask them to repeat the request');
  });

  it('says nothing of it for an authenticated principal', async () => {
    const block = await senderBlock({ channelId: 'signal', resolved: true, identityVerified: true, principal: true, metadata: principalOriginator('signal', true) });
    expect(block).not.toContain(LINE);
  });
});
